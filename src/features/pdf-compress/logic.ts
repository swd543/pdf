/**
 * PDF compression logic — two modes:
 *
 *  lossless  – structural re-save via the Rust/WASM core (lopdf): object
 *              streams + xref streams. Content is byte-for-byte unchanged,
 *              so quality cannot change; size drops when the document has
 *              bloat (uncompressed structure, large xref tables, duplicates).
 *              Falls back to a pdf-lib re-save when the WASM core is absent.
 *
 *  strong    – re-render every page (PDF.js) at the chosen DPI and rebuild
 *              the PDF from optimized JPEGs. Often compresses far more, but
 *              the output is image-based (text no longer selectable).
 */

import { type DpiOption, type ExportedImage, pdfToImages } from '~/features/pdf-to-image/logic';
import { pdflib } from '~/lib/pdflib';
import { CapabilityError, type ProgressFn, yieldToBrowser } from '~/lib/types';
import { wasmLosslessCompress } from '~/lib/wasm';

export type CompressMode = 'lossless' | 'strong';

export interface CompressOptions {
  mode: CompressMode;
  /** Strong mode: JPEG quality 0..1 (default 0.78). */
  quality?: number;
  /** Strong mode: render resolution in DPI (default 150). */
  dpi?: DpiOption;
}

export interface CompressOutcome {
  bytes: Uint8Array;
  /** Which pipeline produced the result. */
  via: 'wasm' | 'js-fallback' | 'strong';
  /** Page count when known. */
  pages: number | null;
}

const DEFAULT_QUALITY = 0.78;
const DEFAULT_DPI = 150 as const;

export async function compressPdf(
  data: ArrayBuffer,
  options: CompressOptions,
  onProgress: ProgressFn,
): Promise<CompressOutcome> {
  if (options.mode === 'lossless') {
    return lossless(data);
  }
  return strong(data, options, onProgress);
}

async function lossless(data: ArrayBuffer): Promise<CompressOutcome> {
  const bytes = new Uint8Array(data);

  // Fast path: Rust core.
  try {
    const out = await wasmLosslessCompress(bytes);
    return { bytes: out, via: 'wasm', pages: null };
  } catch (err) {
    if (err instanceof CapabilityError) {
      // Fall through to the JS pipeline (only when the WASM artifact is
      // missing — real PDF errors re-throw below via the JS path).
    } else {
      throw err;
    }
  }

  // JS fallback: pdf-lib re-save with object streams.
  const { PDFDocument } = await pdflib();
  const doc = await PDFDocument.load(data, { updateMetadata: false, throwOnInvalidObject: false });
  const out = await doc.save({ useObjectStreams: true });
  return { bytes: new Uint8Array(out), via: 'js-fallback', pages: doc.getPageCount() };
}

async function strong(
  data: ArrayBuffer,
  options: CompressOptions,
  onProgress: ProgressFn,
): Promise<CompressOutcome> {
  const quality = options.quality ?? DEFAULT_QUALITY;
  const dpi = options.dpi ?? DEFAULT_DPI;

  // 1. Render every page to JPEG (progress: rendering).
  const pages: ExportedImage[] = await pdfToImages(
    data,
    { format: 'jpeg', quality, dpi },
    (done, total, label) => onProgress(done * 0.8, total * 0.8 + 1, label ?? 'Compressing'),
  );

  // 2. Rebuild the PDF from the pages, preserving original page sizes.
  const { PDFDocument } = await pdflib();
  const doc = await PDFDocument.create();
  doc.setTitle('Compressed document');
  doc.setProducer('PDFBoogie (in-browser, no upload)');

  onProgress(0.85, 1, 'Assembling PDF');
  await yieldToBrowser();

  for (const p of pages) {
    const image = await doc.embedJpg(p.bytes);
    const page = doc.addPage([p.pageWidthPt, p.pageHeightPt]);
    page.drawImage(image, { x: 0, y: 0, width: p.pageWidthPt, height: p.pageHeightPt });
    await yieldToBrowser();
  }

  onProgress(0.95, 1, 'Finalizing');
  const out = await doc.save({ useObjectStreams: true });
  return { bytes: new Uint8Array(out), via: 'strong', pages: pages.length };
}
