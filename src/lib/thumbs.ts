/**
 * Page thumbnail rendering (browser-only).
 *
 * Renders small JPEG data-URL thumbnails of a PDF's pages so tools can show
 * the actual page content (reordering in Merge, previews in Combine /
 * Compress). Rendering is sequential and yields to the browser between
 * pages so the UI stays responsive; `maxThumbs` caps decode + base64 memory
 * and `maxDocumentPages` lets interactive tools reject inputs before any
 * DOM work starts.
 */
import { boundedCanvasSize } from './canvas';
import { disposePdf, pdfDocument } from './pdfjs';
import { yieldToBrowser } from './types';

export interface PageThumbs {
  /** True page count (may exceed thumbs.length when capped). */
  count: number;
  /** JPEG data URLs, one per rendered page (page 1 first). */
  thumbs: string[];
  /** Rendering failed, or the document exceeds the caller's page limit. */
  error?: string;
  /** How many pages' canvas render/encode failed (0 = all pages rendered).
   *  Distinct from `error`: the document opened fine, only the *previews*
   *  are missing (e.g. a mobile engine that can't rasterize them). */
  renderFailures?: number;
  /** Diagnostic: first per-page failure, e.g. "render: ..." / "encode: ...". */
  firstRenderError?: string;
}

export interface PageThumbOptions {
  targetWidth?: number;
  maxThumbs?: number;
  /** Reject before rendering when a page grid/strip could not show it. */
  maxDocumentPages?: number;
}

/**
 * Render bounded thumbnails of an *already-open* document (browser-only).
 * The caller owns the document's lifecycle; `renderPageThumbs` below
 * wraps this with open + dispose for one-shot use.
 */
export async function renderPageThumbsFrom(
  pdf: import('pdfjs-dist').PDFDocumentProxy,
  options: PageThumbOptions = {},
): Promise<PageThumbs> {
  const { targetWidth = 110, maxThumbs = 200, maxDocumentPages } = options;

  const count = pdf.numPages;
  if (maxDocumentPages !== undefined && count > maxDocumentPages) {
    return {
      count,
      thumbs: [],
      error: `This PDF has ${count} pages; this tool can show ${maxDocumentPages}.`,
    };
  }

  const n = Math.min(count, maxThumbs);
  const thumbs: string[] = new Array(n).fill('');

  let renderFailures = 0;
  let firstRenderError: string | undefined;

  for (let i = 1; i <= n; i += 1) {
    let page: import('pdfjs-dist').PDFPageProxy | undefined;
    let canvas: HTMLCanvasElement | null = null;
    // Which step is in flight — so a failure names its cause (a mobile
    // engine often only surfaces the problem here, in the console).
    let stage = 'open page';
    try {
      page = await pdf.getPage(i);
      stage = 'layout';
      const base = page.getViewport({ scale: 1 });
      const scale = targetWidth / base.width;
      const requested = page.getViewport({ scale });
      // Guard against pathological pages (tall/wide, tiny mediabox).
      const bounded = boundedCanvasSize(requested.width, requested.height);
      const viewport = page.getViewport({
        scale: bounded.reduced ? (scale * bounded.width) / requested.width : scale,
      });
      stage = 'canvas';
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context is unavailable');
      stage = 'render';
      await page.render({ canvas, viewport }).promise;
      stage = 'encode';
      thumbs[i - 1] = canvas.toDataURL('image/jpeg', 0.72);
    } catch (err) {
      // A single bad page must not blank the whole document — keep a blank
      // slot (the tile still shows its page number) — but never swallow the
      // cause: on some mobile browsers this is the only place it surfaces.
      renderFailures += 1;
      if (firstRenderError === undefined) {
        const msg = err instanceof Error ? err.message : String(err);
        firstRenderError = `${stage}: ${msg}`;
        console.error(`[pdfboogie] thumbnail page ${i} failed at "${stage}"`, err);
      }
    } finally {
      page?.cleanup();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0; // release the backing store before the next page
      }
    }
    await yieldToBrowser();
  }

  return { count, thumbs, renderFailures, firstRenderError };
}

/**
 * Render bounded thumbnails at roughly `targetWidth` CSS pixels.
 * Pass a *copy* if the buffer will be reused later — pdfjs detaches it.
 */
export async function renderPageThumbs(
  bytes: Uint8Array,
  options: PageThumbOptions = {},
): Promise<PageThumbs> {
  let pdf: import('pdfjs-dist').PDFDocumentProxy;
  try {
    pdf = await pdfDocument(bytes);
  } catch {
    return {
      count: 0,
      thumbs: [],
      error: "Couldn't read this PDF (it may be password-protected).",
    };
  }
  try {
    return await renderPageThumbsFrom(pdf, options);
  } finally {
    await disposePdf(pdf);
  }
}
