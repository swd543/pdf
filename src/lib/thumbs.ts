/**
 * Page thumbnail rendering (browser-only).
 *
 * Renders small JPEG data-URL thumbnails of a PDF's pages so tools can show
 * the actual page content (reordering in Merge, previews in Combine /
 * Compress). Rendering is sequential and yields to the browser between
 * pages so the UI stays responsive on long documents; `maxPages` caps the
 * work (the strip simply shows the first N pages).
 */
import { disposePdf, pdfDocument } from './pdfjs';
import { yieldToBrowser } from './types';

export interface PageThumbs {
  /** True page count (may exceed thumbs.length when capped). */
  count: number;
  /** JPEG data URLs, one per rendered page (page 1 first). */
  thumbs: string[];
  /** Rendering failed (e.g. password-protected or unparseable PDF). */
  error?: string;
}

/**
 * Render up to `maxPages` thumbnails at roughly `targetWidth` CSS pixels.
 * Pass a *copy* if the buffer will be reused later — pdfjs detaches it.
 */
export async function renderPageThumbs(
  bytes: Uint8Array,
  targetWidth = 110,
  maxPages = 200,
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

  const count = pdf.numPages;
  const n = Math.min(count, maxPages);
  const thumbs: string[] = new Array(n).fill('');

  for (let i = 1; i <= n; i += 1) {
    try {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = targetWidth / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        await page.render({ canvas, viewport }).promise;
        thumbs[i - 1] = canvas.toDataURL('image/jpeg', 0.72);
      }
      page.cleanup();
    } catch {
      // Leave a blank slot — the tile still shows its page number.
    }
    await yieldToBrowser();
  }

  await disposePdf(pdf);
  return { count, thumbs };
}
