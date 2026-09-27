/**
 * Sign & fill logic.
 *
 *  - `scanForm`        – lists AcroForm fields + detects legacy XFA.
 *  - `fillForm`        – writes values into fields and regenerates appearances.
 *  - `placeSignatures` – flattens signature images at page coordinates.
 *
 * Coordinates are PDF.js viewport units at scale 1 (== PDF points,
 * top-left origin); converted to pdf-lib's bottom-left origin in
 * `placeSignatures`.
 *
 * NOTE: pdf-lib is imported lazily inside functions so this module stays
 * code-split — the PDF engine only loads when a user actually processes.
 */

import type { PDFImage } from 'pdf-lib';
import { yieldToBrowser } from '~/lib/types';

export type FieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'date' | 'button';

/** Signature creation tabs in the Sign chooser. */
export type SigTab = 'draw' | 'type' | 'upload';

/** A prepared signature ready to be stamped onto pages. */
export interface Signature {
  png: Uint8Array;
  dataUrl: string;
  width: number;
  height: number;
}

/** A placed signature stamp (display coordinates, 1-based page). */
export interface StampView {
  id: string;
  page: number;
  x: number; // display px (top-left)
  y: number;
  w: number;
  h: number;
  png: Uint8Array;
  dataUrl: string;
}

export interface FieldInfo {
  /** Field name (unique within the document — used as the fill key). */
  name: string;
  type: FieldType;
  /** Choices for radio/dropdown fields. */
  choices?: string[];
}

export interface FormScan {
  fields: FieldInfo[];
  /** Legacy Adobe XFA forms — pdf-lib cannot fill these. */
  xfa: boolean;
}

/** A value the UI collected for one field. */
export interface FieldUpdate {
  name: string;
  type: FieldType;
  value: string | boolean;
}

/** A signature stamp to place. `page` is 1-based; x/y are top-left points. */
export interface Stamp {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** PNG bytes (alpha preserved). */
  png: Uint8Array;
}

/**
 * Detect legacy XFA forms via a cheap byte-level scan of the document head.
 * '/XFA' in raw bytes is an extremely reliable positive marker.
 */
export function looksLikeXfa(data: ArrayBuffer | Uint8Array): boolean {
  const max = 256 * 1024;
  const head =
    data instanceof Uint8Array
      ? data.subarray(0, Math.min(data.length, max))
      : new Uint8Array(data, 0, Math.min(data.byteLength, max));
  return new TextDecoder('latin1').decode(head).includes('/XFA');
}

/** Detect a field's UI type structurally (method probing). pdf-lib's field
 * classes are not reliably instanceof-able across versions (e.g. dropdowns
 * are an unexported internal class), so we probe for unique methods:
 * setText → text, check() → checkbox, addOption → dropdown,
 * selectOption → radio. */
function detectFieldType(f: unknown): FieldType {
  const m = f as Record<string, unknown>;
  if (typeof m.setText === 'function') return 'text';
  if (typeof m.check === 'function') return 'checkbox';
  if (typeof m.addOptions === 'function') return 'dropdown'; // PDFDropdown uses addOptions
  if (typeof m.selectOption === 'function') return 'radio';
  return 'button';
}

/** List the fillable fields of a document. */
export async function scanForm(data: ArrayBuffer | Uint8Array): Promise<FormScan> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(data, { throwOnInvalidObject: false });
  const form = doc.getForm();
  const fields: FieldInfo[] = form
    .getFields()
    .map((f) => {
      const type = detectFieldType(f);
      let choices: string[] | undefined;
      if (type === 'radio' || type === 'dropdown') {
        choices = (f as unknown as { getOptions(): string[] }).getOptions();
      }
      return { name: f.getName(), type, choices };
    })
    .filter((f) => f.type !== 'button');
  return { fields, xfa: looksLikeXfa(data) };
}

/** Apply field values and regenerate appearances. Returns new bytes. */
export async function fillForm(
  data: ArrayBuffer | Uint8Array,
  updates: FieldUpdate[],
): Promise<Uint8Array> {
  if (updates.length === 0) throw new Error('Nothing to fill');
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(data, { throwOnInvalidObject: false });
  const form = doc.getForm();
  const font = await doc.embedFont((await import('pdf-lib')).StandardFonts.Helvetica);

  for (const update of updates) {
    try {
      switch (update.type) {
        case 'text': {
          if (typeof update.value === 'string' && update.value !== '') {
            form.getTextField(update.name).setText(update.value);
          }
          break;
        }
        case 'checkbox': {
          const field = form.getCheckBox(update.name);
          if (update.value === true) field.check();
          else field.uncheck();
          break;
        }
        case 'radio': {
          if (typeof update.value === 'string' && update.value !== '') {
            form.getRadioGroup(update.name).select(update.value);
          }
          break;
        }
        case 'dropdown': {
          if (typeof update.value === 'string' && update.value !== '') {
            form.getDropdown(update.name).select(update.value);
          }
          break;
        }
        default:
          break; // date & button: not fillable in this build (UI disables them)
      }
    } catch {
      // Skip fields we can't touch (locked, or name/type mismatch) —
      // partial application beats total failure.
    }
  }

  form.updateFieldAppearances(font);
  const out = await doc.save();
  return new Uint8Array(out);
}

/** Flatten signature stamps onto pages. Returns new bytes. */
export async function placeSignatures(
  data: ArrayBuffer | Uint8Array,
  stamps: Stamp[],
): Promise<Uint8Array> {
  if (stamps.length === 0) throw new Error('No signatures to apply');
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(data, { throwOnInvalidObject: false });
  const pageCount = doc.getPageCount();
  if (pageCount === 0) throw new Error('Empty document');

  // Embed each unique PNG once (the same signature may be placed twice).
  const embedded = new Map<number, PDFImage>();

  for (const stamp of stamps) {
    const page = doc.getPage(stamp.page - 1);
    if (!page) throw new Error(`Page ${stamp.page} does not exist`);
    const { height: pageH } = page.getSize();

    const key = fnv1a(stamp.png);
    let image = embedded.get(key);
    if (!image) {
      image = await doc.embedPng(stamp.png);
      embedded.set(key, image);
      await yieldToBrowser();
    }

    // Top-left (pdf.js) → bottom-left (pdf-lib) origin.
    page.drawImage(image, {
      x: stamp.x,
      y: pageH - stamp.y - stamp.height,
      width: stamp.width,
      height: stamp.height,
    });
  }

  const out = await doc.save();
  return new Uint8Array(out);
}

/** FNV-1a 32-bit content hash (cheap identity for the embed cache). */
function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
