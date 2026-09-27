/**
 * Combine preview session (handoff P1.1).
 *
 * One opened PDF.js document, shared by the initial thumbnails and every
 * live sheet preview while the file is selected. The old flow re-read the
 * whole File and re-parsed the document on every checkbox/layout change;
 * this keeps a single open document and cancels superseded preview renders
 * instead of merely discarding their results.
 *
 * Ownership: the route creates one session per selected file and MUST call
 * `dispose()` on file replacement, Clear, and route unmount.
 */
import { disposePdf, pdfDocument } from '~/lib/pdfjs';
import { renderPageThumbsFrom } from '~/lib/thumbs';
import { previewSheetsFrom } from './logic';

export interface SheetPreviewOptions {
  cols: number;
  rows: number;
  sheetW: number;
  sheetH: number;
}

export interface SheetPreview {
  urls: string[];
  total: number;
}

export class CombinePreviewSession {
  private pdf: import('pdfjs-dist').PDFDocumentProxy | null = null;
  private disposed = false;
  /** In-flight preview render (pdfjs 6 cancels via RenderTask). */
  private previewTask: import('pdfjs-dist').RenderTask | null = null;

  /** Open the document (pass a copy — pdfjs detaches its input). */
  async open(bytes: Uint8Array): Promise<number> {
    if (this.disposed || this.pdf) throw new Error('Session already open');
    this.pdf = await pdfDocument(bytes);
    return this.pdf.numPages;
  }

  /** JPEG data URLs for the first `maxThumbs` pages (page 1 first). */
  async thumbs(targetWidth: number, maxThumbs: number): Promise<string[]> {
    if (!this.pdf) throw new Error('Session not open');
    const r = await renderPageThumbsFrom(this.pdf, { targetWidth, maxThumbs });
    if (r.error) throw new Error(r.error);
    return r.thumbs;
  }

  /**
   * Render the first sheets for the current selection (low resolution).
   * A newer call cancels the previous in-flight render, so superseded
   * previews stop wasting CPU — not just discarding their results.
   */
  previewSheets(selected: number[], options: SheetPreviewOptions): Promise<SheetPreview> {
    if (!this.pdf) throw new Error('Session not open');
    if (this.previewTask) {
      this.previewTask.cancel();
      this.previewTask = null;
    }
    const pdf = this.pdf;
    const task = previewSheetsFrom(pdf, selected, options, 3, 260, (render) => {
      this.previewTask = render;
    });
    return task;
  }

  /** Release the document. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.previewTask?.cancel();
    this.previewTask = null;
    const pdf = this.pdf;
    this.pdf = null;
    if (pdf) await disposePdf(pdf);
  }
}
