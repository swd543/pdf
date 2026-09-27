/**
 * Merge logic: combine multiple PDFs — and images (JPG, PNG, …) — into a
 * single PDF, in the order the user arranged them.
 *
 *  - PDF inputs are copied page-for-page with pdf-lib (vector content is
 *    preserved exactly; no re-encoding).
 *  - Image inputs reuse the image-to-pdf embedding pipeline (JPEG fast
 *    path, bitmap re-encode for exotic formats, page size + margins).
 *
 * pdf-lib is imported lazily so the merge page's chunk stays lean.
 */
import type { PDFDocument as PdfDoc } from 'pdf-lib';
import type { OperationContext } from '~/lib/operation';
import { pdflib } from '~/lib/pdflib';
import { type ProgressFn, yieldToBrowser } from '~/lib/types';
import { addImagePage, type PageSize, prepareImage } from '../image-to-pdf/logic';

export type MergeInput =
  | { kind: 'pdf'; name: string; bytes: Uint8Array }
  | { kind: 'image'; name: string; file: File };

export interface MergeOptions {
  /** Page size for *image* inputs (PDF pages keep their own size). */
  pageSize: PageSize;
  /** Margins in points, applied to image pages. */
  marginPt: number;
  /** Cancellation context — checkpoint between files/pages (P1.6). */
  op?: OperationContext;
}

/** Merge the given inputs (in order) into one PDF. */
export async function mergeFiles(
  inputs: MergeInput[],
  options: MergeOptions,
  onProgress: ProgressFn,
): Promise<Uint8Array> {
  if (inputs.length === 0) throw new Error('Nothing to merge — add at least two files.');

  const { PDFDocument } = await pdflib();
  const doc = await PDFDocument.create();
  doc.setTitle('Merged document');
  doc.setProducer('PDFBoogie (in-browser, no upload)');

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i]!;
    onProgress(i, inputs.length, `Reading ${input.name}…`);
    await yieldToBrowser();

    if (input.kind === 'pdf') {
      const src = await loadSource(input.name, input.bytes);
      const copied = await doc.copyPages(src, src.getPageIndices());
      for (const page of copied) doc.addPage(page);
    } else {
      const prep = await prepareImage(input.file);
      await addImagePage(doc, prep, options);
    }

    onProgress(i + 1, inputs.length, `Added ${input.name}`);
    await yieldToBrowser();
  }

  onProgress(inputs.length, inputs.length, 'Assembling PDF');
  return doc.save();
}

/** Load a source PDF with friendly errors (shared by both merge APIs). */
async function loadSource(name: string, bytes: Uint8Array): Promise<PdfDoc> {
  const { PDFDocument } = await pdflib();
  let src: PdfDoc;
  try {
    src = await PDFDocument.load(bytes, { throwOnInvalidObject: false });
  } catch {
    throw new Error(
      `Couldn't read “${name}” — is it a valid PDF? Password-protected PDFs can't be merged.`,
    );
  }
  if (src.getPageCount() === 0) {
    throw new Error(`“${name}” has no pages.`);
  }
  return src;
}

/**
 * A single page slot in the user-arranged sequence (page-level reordering):
 * either one page of a PDF (1-based `page`) or an image (its own page).
 */
export type MergePageRef =
  | { kind: 'image'; name: string; file: File }
  | { kind: 'pdf'; name: string; bytes: Uint8Array; page: number };

/**
 * Merge an explicit *page* sequence — individual pages of the given PDFs in
 * the exact order the user arranged them, images interleaved freely.
 * Source documents are loaded once per distinct buffer.
 */
export async function mergePages(
  refs: MergePageRef[],
  options: MergeOptions,
  onProgress: ProgressFn,
): Promise<Uint8Array> {
  if (refs.length === 0) throw new Error('Nothing to merge — add at least one page.');

  const { PDFDocument } = await pdflib();
  const doc = await PDFDocument.create();
  doc.setTitle('Merged document');
  doc.setProducer('PDFBoogie (in-browser, no upload)');

  // Source documents are loaded once per distinct buffer identity. The
  // route keeps exactly one Uint8Array per file, so the object itself is a
  // safe key — interleaved sequences (A1, B1, A2, B2) re-use both docs
  // instead of re-parsing on every switch.
  const srcCache = new Map<Uint8Array, PdfDoc>();

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i]!;
    onProgress(i, refs.length, `Page ${i + 1} of ${refs.length}`);
    if (options.op) await options.op.checkpoint();
    else await yieldToBrowser();

    if (ref.kind === 'image') {
      const prep = await prepareImage(ref.file);
      await addImagePage(doc, prep, options);
    } else {
      let src = srcCache.get(ref.bytes);
      if (!src) {
        src = await loadSource(ref.name, ref.bytes);
        srcCache.set(ref.bytes, src);
      }
      const n = src.getPageCount();
      if (!Number.isInteger(ref.page) || ref.page < 1 || ref.page > n) {
        throw new Error(`Page ${ref.page} of “${ref.name}” doesn't exist.`);
      }
      const [page] = await doc.copyPages(src, [ref.page - 1]);
      doc.addPage(page);
    }
  }

  onProgress(refs.length, refs.length, 'Assembling PDF');
  return doc.save();
}
