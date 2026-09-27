/**
 * Page thumbnail rendering (browser-only).
 *
 * Renders small JPEG data-URL thumbnails of a PDF's pages so tools can show
 * the actual page content (reordering in Merge, previews in Combine /
 * Compress). Rendering is sequential and yields to the browser between
 * pages so the UI stays responsive on long documents; `maxPages` caps the
 * work (the strip simply shows the first N pages).
 */
import { PAGE_SIZES, type PageSize } from '~/features/image-to-pdf/logic';
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

/** Same 96→72 dpi assumption the merge / image-to-pdf output uses. */
const FIT_SCALE = 72 / 96;

/**
 * Preview an image page exactly as it will appear in the merged output:
 * the image letterboxed inside its target page size with the selected
 * margins (identical math to `addImagePage` in the image-to-pdf logic).
 * Returns a JPEG data URL at roughly `targetWidth` CSS px.
 */
export async function renderImagePagePreview(
  file: File,
  pageSize: PageSize,
  marginPt: number,
  targetWidth = 110,
): Promise<string> {
  const bmp = await createImageBitmap(file);
  try {
    // Page geometry in the same units the output uses (PDF points).
    const pageW = pageSize === 'fit' ? bmp.width * FIT_SCALE : PAGE_SIZES[pageSize][0]!;
    const pageH = pageSize === 'fit' ? bmp.height * FIT_SCALE : PAGE_SIZES[pageSize][1]!;
    const cw = targetWidth;
    const ch = Math.max(1, Math.round((targetWidth * pageH) / pageW));
    const m = (marginPt / pageW) * cw; // margins in canvas px
    const boxW = cw - m * 2;
    const boxH = ch - m * 2;
    if (boxW <= 0 || boxH <= 0) return '';
    const scale = Math.min(boxW / bmp.width, boxH / bmp.height);
    const w = bmp.width * scale;
    const h = bmp.height * scale;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cw));
    canvas.height = Math.max(1, Math.round(ch));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    return canvas.toDataURL('image/jpeg', 0.72);
  } finally {
    bmp.close();
  }
}
