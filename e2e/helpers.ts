/**
 * Shared E2E helpers:
 *  - file dropping (synthetic HTML5 drag&drop + native <input> path)
 *  - in-page canvas image generation (PNG/JPEG/WebP, exact dimensions)
 *  - download capture (real browser downloads of the site's blobs)
 *  - Node-side validators for PDF / ZIP / PNG / JPEG / WebP / DOCX / ODT
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import pdfLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';

/**
 * pdfjs (Node-side validators below) calls Uint8Array.prototype.toHex()
 * during getDocument() (document fingerprint). Node < 26 lacks it — patch
 * so the suite works on any Node (CI runs Node 24).
 */
{
  const proto = Uint8Array.prototype as { toHex?: () => string };
  if (typeof proto.toHex !== 'function') {
    proto.toHex = function (this: Uint8Array): string {
      let out = '';
      for (let i = 0; i < this.length; i += 1) out += this[i]!.toString(16).padStart(2, '0');
      return out;
    };
  }
}

/**
 * pdfjs v6's getOperatorList()/render path calls
 * `Map.prototype.getOrInsertComputed()` (Node 26+). CI runs Node 24, which
 * lacks it, so the Node-side validators below would throw. Patch it in (the
 * browser has the same shim in src/lib/pdfjs.ts).
 */
{
  const proto = Map.prototype as unknown as {
    getOrInsertComputed?: (key: unknown, make: () => unknown) => unknown;
  };
  if (typeof proto.getOrInsertComputed !== 'function') {
    proto.getOrInsertComputed = function (
      this: Map<unknown, unknown>,
      key: unknown,
      make: () => unknown,
    ): unknown {
      if (this.has(key)) return this.get(key);
      const value = make();
      this.set(key, value);
      return value;
    };
  }
}

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

/* ------------------------------------------------------------------ */
/* Page-side actions                                                   */
/* ------------------------------------------------------------------ */

/** Copy e2e/fixtures → dist/e2e/fixtures so the site serves them same-origin. */
export function syncFixturesToDist(): number {
  const src = path.join(import.meta.dirname, 'fixtures');
  const dest = path.join(import.meta.dirname, '..', 'dist', 'e2e', 'fixtures');
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (f.endsWith('.pdf')) {
      fs.copyFileSync(path.join(src, f), path.join(dest, f));
      n += 1;
    }
  }
  return n;
}

/**
 * Drop fixture PDFs (served same-origin under /e2e/fixtures/) onto
 * `.dropzone` via a synthetic HTML5 drop. No bytes cross the CDP bridge.
 */
export async function dropFixtures(page: Page, names: string[]): Promise<void> {
  await page.evaluate(async (ns: string[]) => {
    const dt = new DataTransfer();
    for (const name of ns) {
      const res = await fetch(`/e2e/fixtures/${name}`);
      if (!res.ok) throw new Error(`fixture fetch failed: ${name} (${res.status})`);
      const file = new File([new Uint8Array(await res.arrayBuffer())], name, {
        type: 'application/pdf',
      });
      dt.items.add(file);
    }
    const target = document.querySelector('.dropzone') as HTMLElement;
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
  }, names);
}

/** In-page canvas → File specs (no bytes cross the page boundary). */
interface CanvasImageSpec {
  name: string;
  mime: string;
  w: number;
  h: number;
  /** 'solid' | 'hgrad' | 'vgrad' | 'quarters' — enough to verify orientation. */
  paint: string;
  color?: number[];
}

export async function makeCanvasImages(page: Page, specs: CanvasImageSpec[]): Promise<void> {
  await page.evaluate(async (specs: CanvasImageSpec[]) => {
    const dt = new DataTransfer();
    for (const s of specs) {
      const c = document.createElement('canvas');
      c.width = s.w;
      c.height = s.h;
      const ctx = c.getContext('2d')!;
      const [cr, cg, cb] = s.color ?? [80, 80, 200];
      if (s.paint === 'solid') {
        ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        ctx.fillRect(0, 0, c.width, c.height);
      } else if (s.paint === 'hgrad') {
        const g = ctx.createLinearGradient(0, 0, c.width, 0);
        g.addColorStop(0, `rgb(${cr},${cg},${cb})`);
        g.addColorStop(1, 'white');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, c.width, c.height);
      } else if (s.paint === 'vgrad') {
        const g = ctx.createLinearGradient(0, 0, 0, c.height);
        g.addColorStop(0, `rgb(${cr},${cg},${cb})`);
        g.addColorStop(1, 'white');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, c.width, c.height);
      } else {
        // quarters: top-left red, top-right green, bottom-left blue, bottom-right yellow
        ctx.fillStyle = '#d00';
        ctx.fillRect(0, 0, c.width / 2, c.height / 2);
        ctx.fillStyle = '#0a0';
        ctx.fillRect(c.width / 2, 0, c.width / 2, c.height / 2);
        ctx.fillStyle = '#00d';
        ctx.fillRect(0, c.height / 2, c.width / 2, c.height / 2);
        ctx.fillStyle = '#dd0';
        ctx.fillRect(c.width / 2, c.height / 2, c.width / 2, c.height / 2);
      }
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, s.mime));
      if (!blob) throw new Error(`canvas toBlob failed for ${s.name}`);
      dt.items.add(new File([blob], s.name, { type: s.mime }));
    }
    const target = document.querySelector('.dropzone') as HTMLElement;
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
  }, specs);
}

export interface DropFileSpec {
  name: string;
  type: string;
  /** Raw bytes (kept small). */
  data: number[];
}

/** Dispatch a synthetic HTML5 drop of inline files onto `.dropzone`. */
export async function dropFiles(page: Page, dropzone: DropFileSpec[]): Promise<void> {
  await page.evaluate((specs: DropFileSpec[]) => {
    const dt = new DataTransfer();
    for (const s of specs) {
      dt.items.add(new File([new Uint8Array(s.data)], s.name, { type: s.type }));
    }
    const target = document.querySelector('.dropzone') as HTMLElement;
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
  }, dropzone);
}
export async function inputFiles(
  page: Page,
  files: { name: string; type: string; data: number[] }[],
): Promise<void> {
  const abs = files.map((f) => {
    const p = path.join(import.meta.dirname, '.tmp-input', f.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(f.data));
    return p;
  });
  await page.locator('.dz-input').first().setInputFiles(abs);
}

/**
 * Run `action` and capture the download it triggers (the site downloads via
 * object-URL anchor clicks, which Chromium reports as downloads).
 */
export async function captureDownload(
  page: Page,
  action: () => Promise<void>,
): Promise<Uint8Array> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    action(),
  ]);
  const p = await download.path();
  const buf = fs.readFileSync(p!); // Buffer — a Uint8Array subclass with readUInt*BE/LE helpers
  fs.rmSync(p!, { force: true });
  return buf;
}

export const clickButton = (page: Page, re: RegExp) =>
  page.locator('button', { hasText: re }).first().click();

/**
 * Tools no longer auto-download: click the processing CTA, wait for the
 * result card, then click its Download button and capture the file.
 */
export async function processAndDownload(
  page: Page,
  cta: RegExp,
  downloadRe: RegExp = /^Download/,
): Promise<Uint8Array> {
  await clickButton(page, cta);
  await page.waitForSelector('.result-card', { timeout: 120_000 });
  return captureDownload(page, () => clickButton(page, downloadRe));
}

/* ------------------------------------------------------------------ */
/* Node-side validators                                                */
/* ------------------------------------------------------------------ */

export interface PdfPageInfo {
  w: number;
  h: number;
  text: string;
}

export interface PdfInfo {
  pages: PdfPageInfo[];
}

export async function pdfInfo(data: Uint8Array): Promise<PdfInfo> {
  // pdfjs v6 rejects Node Buffers AND takes ownership of the buffer it is
  // given (it detaches the original) — pass a plain Uint8Array *copy* so
  // the caller's bytes stay usable afterwards.
  const u8 = new Uint8Array(data);
  const pdf = await pdfjs.getDocument({ data: u8, isEvalSupported: false, useSystemFonts: false })
    .promise;
  const pages: PdfPageInfo[] = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => ('str' in it ? it.str : '')).join('');
    pages.push({ w: vp.width, h: vp.height, text });
  }
  await pdf.cleanup();
  return { pages };
}

export interface PdfImagePlacement {
  width: number;
  height: number;
  x: number;
  /** Bottom-origin PDF y coordinate. */
  y: number;
}

/** Image placement matrices from a page's PDF.js operator list.
 *
 * Used by Sign E2E tests to prove that a stamp's downloaded PDF position
 * matches its preview, rather than merely proving that an image exists.
 */
export async function pdfImagePlacements(
  data: Uint8Array,
  pageNumber = 1,
): Promise<PdfImagePlacement[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const ops = await page.getOperatorList();
    const placements: PdfImagePlacement[] = [];
    type Matrix = [number, number, number, number, number, number];
    const multiply = (m1: Matrix, m2: Matrix): Matrix => [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    for (let i = 0; i < ops.fnArray.length; i += 1) {
      const fn = ops.fnArray[i];
      if (fn === pdfjs.OPS.save) {
        stack.push([...ctm]);
      } else if (fn === pdfjs.OPS.restore) {
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      } else if (fn === pdfjs.OPS.transform) {
        const args = ops.argsArray[i];
        if (Array.isArray(args) && args.length >= 6) ctm = multiply(ctm, args as Matrix);
      } else if (fn === pdfjs.OPS.paintImageXObject) {
        placements.push({
          width: Math.hypot(ctm[0], ctm[1]),
          height: Math.hypot(ctm[2], ctm[3]),
          x: ctm[4],
          y: ctm[5],
        });
      }
    }
    return placements;
  } finally {
    await pdf.cleanup();
  }
}

export function zipEntries(data: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(data);
}

// Binary validators: ZIP entries (fflate) are plain Uint8Arrays, so every
// validator normalizes to a Node Buffer for readUInt*BE/LE + toString(enc).
export function pngSize(data: Uint8Array): { w: number; h: number } | null {
  const buf = Buffer.from(data);
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export function jpegSize(data: Uint8Array): { w: number; h: number } | null {
  const buf = Buffer.from(data);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off += 1;
      continue;
    }
    const marker = buf[off + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return null;
}

export function webpSize(data: Uint8Array): { w: number; h: number } | null {
  const buf = Buffer.from(data);
  if (buf.length < 30) return null;
  const sig = buf.subarray(0, 4).toString('ascii');
  const fourcc = buf.subarray(8, 12).toString('ascii');
  if (sig !== 'RIFF' || fourcc !== 'WEBP') return null;
  if (fourcc === 'WEBP' && buf.subarray(12, 16).toString('ascii') === 'VP8X') {
    // VP8X: 24-bit little-endian dimensions (minus 1) at offsets 24 / 27
    const w = (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1;
    const h = (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1;
    return { w, h };
  }
  if (buf.subarray(12, 16).toString('ascii') === 'VP8 ') {
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf.subarray(12, 16).toString('ascii') === 'VP8L') {
    const b1 = buf[21];
    const b2 = buf[22];
    const b3 = buf[23];
    const w = (b1 | ((b2 & 0x3f) << 8)) + 1;
    const h = ((b2 & 0xc0) << 6) | (b3 << 2) | 0;
    return { w, h: (h >>> 0) + 1 };
  }
  return null;
}

const stripXmlTags = (xml: string) => xml.replace(/<[^>]+>/g, ' ');

export function docxText(data: Uint8Array): string {
  const entries = unzipSync(data);
  const xml = entries['word/document.xml'];
  if (!xml) throw new Error('docx: word/document.xml missing');
  return stripXmlTags(new TextDecoder().decode(xml)).replace(/\s+/g, ' ');
}

export function docxXml(data: Uint8Array): string {
  const entries = unzipSync(data);
  const xml = entries['word/document.xml'];
  if (!xml) throw new Error('docx: word/document.xml missing');
  return new TextDecoder().decode(xml);
}

export function odtXml(data: Uint8Array, part: string): string {
  const entries = unzipSync(data);
  const xml = entries[part];
  if (!xml) throw new Error(`odt: ${part} missing`);
  return new TextDecoder().decode(xml);
}

/** First ZIP entry name + compression method (ODF mimetype-first check). */
export function firstZipEntry(data: Uint8Array): { name: string; method: number } {
  const nlen = data.readUInt16LE(26);
  return {
    name: data.subarray(30, 30 + nlen).toString('ascii'),
    method: data.readUInt16LE(8),
  };
}

/** pdf-lib round-trip: read AcroForm field values from a saved PDF. */
export async function formFieldValues(data: Uint8Array): Promise<Record<string, string | boolean>> {
  const doc = await pdfLib.PDFDocument.load(data, { ignoreEncryption: false });
  const form = doc.getForm();
  const out: Record<string, string | boolean> = {};
  for (const field of form.getFields()) {
    if (field.constructor.name === 'PDFTextField') {
      out[field.getName()] = field.getText();
    } else if (field.constructor.name === 'PDFCheckBox') {
      out[field.getName()] = field.isChecked();
    } else if (
      field.constructor.name === 'PDFDropdown' ||
      field.constructor.name === 'PDFRadioGroup'
    ) {
      out[field.getName()] = String(field.getSelected());
    }
  }
  return out;
}
