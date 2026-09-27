/**
 * PDF → Image logic: render pages with PDF.js, export via canvas.
 *
 * Runs in the browser only (needs DOM canvases); the pure helpers
 * (range math, file names) are unit-tested in Node.
 *
 * Memory model (handoff P0.5/P1.5): `forEachPdfImage` is the streaming
 * primitive — it hands each encoded page to a consumer immediately so
 * callers (ZIP export, strong compression) never retain every page at
 * once. `pdfToImages` is the convenience collector on top.
 */
import { boundedCanvasSize, releaseCanvas } from '~/lib/canvas';
import { canvasToJpeg, canvasToPng, canvasToWebP } from '~/lib/imaging';
import type { OperationContext } from '~/lib/operation';
import { disposePdf, pdfDocument } from '~/lib/pdfjs';
import type { ProgressFn } from '~/lib/types';

export type ExportFormat = 'png' | 'jpeg' | 'webp';
export type DpiOption = 96 | 150 | 220 | 300;

export interface PdfToImageOptions {
  format: ExportFormat;
  /** JPEG/WebP quality, 0..1. Ignored for PNG. */
  quality: number;
  /** Output resolution in DPI (PDF base is 72). */
  dpi: DpiOption;
  /** 1-based first page to export (inclusive). */
  from?: number;
  /** 1-based last page to export (inclusive). */
  to?: number;
  /** Cancellation context — render tasks abort with it (P1.6). */
  op?: OperationContext;
}

export interface ExportedImage {
  /** 1-based page number. */
  page: number;
  bytes: Uint8Array;
  mime: string;
  ext: string;
  width: number;
  height: number;
  /** Original page size in PDF points (used by strong-compress rebuilds). */
  pageWidthPt: number;
  pageHeightPt: number;
}

export type ExportedImageConsumer = (image: ExportedImage) => void | Promise<void>;

const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export { MIME };

/** Validate/normalise a page range against the document size. */
export function resolveRange(from: number | undefined, to: number | undefined, numPages: number) {
  const clamp = (n: number) => Math.min(Math.max(1, Math.floor(n)), numPages);
  let first = clamp(from ?? 1);
  let last = clamp(to ?? numPages);
  if (last < first) [first, last] = [last, first]; // swapped input → use as-is
  return { first, last };
}

/** Suggested file name for a page export. */
export function pageFileName(base: string, page: number, ext: string, multiPage: boolean): string {
  const name = base.replace(/\.pdf$/i, '') || 'document';
  return multiPage ? `${name}-page-${String(page).padStart(3, '0')}.${ext}` : `${name}.${ext}`;
}

/**
 * Render a page range and hand each encoded image to `onImage` as soon as
 * it is ready. Returns the number of pages processed. Aborts with
 * `AbortError` when the operation's signal fires.
 */
export async function forEachPdfImage(
  data: ArrayBuffer,
  options: PdfToImageOptions,
  onImage: ExportedImageConsumer,
  onProgress: ProgressFn,
): Promise<number> {
  if (!data || data.byteLength === 0) throw new Error('Empty file');
  const pdf = await pdfDocument(new Uint8Array(data));

  try {
    if (pdf.numPages === 0) throw new Error('This PDF has no pages');
    const { first, last } = resolveRange(options.from, options.to, pdf.numPages);
    const total = last - first + 1;
    const scale = options.dpi / 72;

    for (let page = first; page <= last; page += 1) {
      onProgress(page - first, total, `Rendering page ${page} of ${total}`);
      const view = await renderOnePage(pdf, page, scale, options);
      await onImage({
        page,
        bytes: view.bytes,
        mime: view.mime,
        ext: options.format,
        width: view.width,
        height: view.height,
        pageWidthPt: view.pageWidthPt,
        pageHeightPt: view.pageHeightPt,
      });
      // Event-loop turn + cancellation point between pages.
      if (options.op) await options.op.checkpoint();
    }
    return total;
  } finally {
    // Release the document (frees worker memory for the next operation).
    await disposePdf(pdf);
  }
}

/** Render a page range to an in-memory image array (small exports). */
export async function pdfToImages(
  data: ArrayBuffer,
  options: PdfToImageOptions,
  onProgress: ProgressFn,
): Promise<ExportedImage[]> {
  const out: ExportedImage[] = [];
  await forEachPdfImage(
    data,
    options,
    (image) => {
      out.push(image);
    },
    onProgress,
  );
  return out;
}

interface RenderedPage {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  pageWidthPt: number;
  pageHeightPt: number;
}

/** Render a single page of an open document to image bytes. */
async function renderOnePage(
  pdf: import('pdfjs-dist').PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  options: PdfToImageOptions,
): Promise<RenderedPage> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });

  let viewport = page.getViewport({ scale });
  const bounded = boundedCanvasSize(viewport.width, viewport.height);
  if (bounded.reduced) {
    // Lower the render scale (aspect preserved) instead of stretching a
    // canvas that would exceed GPU limits.
    viewport = page.getViewport({ scale: (scale * bounded.width) / viewport.width });
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d', { desynchronized: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // Opaque background for lossy formats (JPEG/WebP have no alpha).
  if (options.format !== 'png') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // pdfjs 6 cancels through RenderTask.cancel() — bridge from the op signal.
  const task = page.render({ canvas, viewport });
  const cancelTask = () => task.cancel();
  if (options.op) {
    if (options.op.signal.aborted) task.cancel();
    else options.op.signal.addEventListener('abort', cancelTask, { once: true });
  }
  try {
    await task.promise;
  } catch (err) {
    if (options.op?.signal.aborted) throw new DOMException('Operation cancelled', 'AbortError');
    throw err;
  } finally {
    if (options.op) options.op.signal.removeEventListener('abort', cancelTask);
  }

  let bytes: Uint8Array;
  if (options.format === 'png') bytes = await canvasToPng(canvas);
  else if (options.format === 'jpeg') bytes = await canvasToJpeg(canvas, options.quality);
  else bytes = await canvasToWebP(canvas, options.quality);
  const mime = MIME[options.format];

  const width = canvas.width;
  const height = canvas.height;
  releaseCanvas(canvas); // free the backing store before the next page
  page.cleanup();

  return {
    bytes,
    mime,
    width,
    height,
    pageWidthPt: base.width,
    pageHeightPt: base.height,
  };
}
