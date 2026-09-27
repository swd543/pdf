/**
 * Lazy, bounded page renderer for the Sign stage (handoff P0.1).
 *
 * Owns one PDFDocumentProxy and renders only the pages in the route's
 * desired "window" (the pages near the viewport) into canvases the route
 * registers. At most MAX_SIGNED_PAGE_CANVASES full backing stores stay
 * alive; released canvases are zeroed, so a 500-page document costs five
 * canvases, not five hundred.
 *
 * Lifecycle: the route creates a renderer per open document and MUST call
 * `dispose()` on file replacement, Clear, and route unmount. In-flight
 * render tasks are cancelled (not merely abandoned) on invalidate/dispose.
 */
import { boundedCanvasSize } from '~/lib/canvas';
import { MAX_SIGNED_PAGE_CANVASES } from '~/lib/limits';
import { disposePdf, pdfDocument } from '~/lib/pdfjs';

export interface PageMeta {
  widthPt: number;
  heightPt: number;
}

type PDFProxy = import('pdfjs-dist').PDFDocumentProxy;
type PDFRenderTask = import('pdfjs-dist').RenderTask;

export class SignPageRenderer {
  private pdf: PDFProxy | null = null;
  private scale = 1;
  private canvases = new Map<number, HTMLCanvasElement>();
  /** Pages with a live backing store. */
  private live = new Set<number>();
  /** In-flight render promises, by page. */
  private tasks = new Map<number, Promise<void>>();
  /** In-flight pdfjs render tasks, by page (cancelled on release). */
  private renderTasks = new Map<number, PDFRenderTask>();
  /** Bumped on invalidate/dispose; stale work checks it. */
  private version = 0;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  /**
   * Open the document and return per-page metadata. Pass a copy of the
   * bytes — pdfjs detaches its input.
   */
  async open(bytes: Uint8Array, scale: number): Promise<PageMeta[]> {
    if (this.disposed || this.pdf) throw new Error('Renderer already open');
    this.scale = scale;
    const pdf = await pdfDocument(bytes);
    this.pdf = pdf;
    const metas: PageMeta[] = [];
    for (let p = 1; p <= pdf.numPages; p += 1) {
      const page = await pdf.getPage(p);
      const base = page.getViewport({ scale: 1 });
      metas.push({ widthPt: base.width, heightPt: base.height });
      page.cleanup();
    }
    return metas;
  }

  /** Register (or unregister) the canvas for a page. Rendering happens
   *  only through `syncWindow` (observer-driven); registration just records
   *  the element so late syncs find it. */
  registerCanvas(page: number, el: HTMLCanvasElement | null): void {
    if (el) {
      this.canvases.set(page, el);
    } else {
      this.canvases.delete(page);
      this.releasePage(page);
    }
  }

  /**
   * Make `keep` (most-visible first) the desired live set: render missing
   * pages in order, release pages that fell out of the window. Serialized
   * through an internal queue; safe to call rapidly.
   */
  syncWindow(keep: number[]): void {
    this.queue = this.queue.then(() => this.doSync(keep)).catch(() => undefined); // never poison the queue
  }

  /** Change the display scale. Invalidates live renders (canvases are
   *  repainted lazily by the next window sync). */
  setScale(scale: number): void {
    this.scale = scale;
    this.invalidateAll();
  }

  /** Cancel all in-flight renders and release every backing store. */
  invalidateAll(): void {
    this.version += 1;
    for (const p of [...this.live]) this.releasePage(p);
    for (const [p, task] of this.renderTasks) {
      task.cancel();
      this.renderTasks.delete(p);
      this.tasks.delete(p);
    }
  }

  /** Release everything and dispose the document. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateAll();
    this.canvases.clear();
    const pdf = this.pdf;
    this.pdf = null;
    if (pdf) await disposePdf(pdf);
  }

  /* ---------------- internals ---------------- */

  private async doSync(keep: number[]): Promise<void> {
    if (this.disposed || !this.pdf) return;
    const version = this.version;
    const wanted = keep.slice(0, MAX_SIGNED_PAGE_CANVASES);
    // Cancel in-flight renders that left the window (before they finish).
    for (const p of [...this.tasks.keys()]) {
      if (!wanted.includes(p)) this.releasePage(p);
    }
    // Release pages that left the window.
    for (const p of [...this.live]) {
      if (!wanted.includes(p)) this.releasePage(p);
    }
    // Render missing pages, most-visible first.
    for (const p of wanted) {
      if (version !== this.version || this.disposed) return;
      if (this.live.has(p) || this.tasks.has(p)) continue;
      await this.renderPage(p);
    }
  }

  private async renderPage(pageNo: number): Promise<void> {
    const pdf = this.pdf;
    if (!pdf || this.disposed) return;
    const canvas = this.canvases.get(pageNo);
    if (!canvas) return; // element not mounted yet; retried by the next sync
    const version = this.version;
    const task = (async () => {
      const page = await pdf.getPage(pageNo);
      const requested = page.getViewport({ scale: this.scale });
      const bounded = boundedCanvasSize(requested.width, requested.height);
      const viewport = bounded.reduced
        ? page.getViewport({ scale: (this.scale * bounded.width) / requested.width })
        : requested;
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        page.cleanup();
        return;
      }
      const render = page.render({ canvas, viewport });
      this.renderTasks.set(pageNo, render);
      try {
        await render.promise;
      } catch (err) {
        if (version === this.version) throw err;
        // Superseded/cancelled render — expected, not a failure.
      } finally {
        this.renderTasks.delete(pageNo);
        page.cleanup();
      }
    })();
    this.tasks.set(pageNo, task);
    try {
      await task;
      if (version === this.version) this.live.add(pageNo);
    } finally {
      this.tasks.delete(pageNo);
    }
  }

  private releasePage(pageNo: number): void {
    this.renderTasks.get(pageNo)?.cancel();
    this.renderTasks.delete(pageNo);
    this.tasks.delete(pageNo);
    this.live.delete(pageNo);
    const canvas = this.canvases.get(pageNo);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0; // release the backing store; the element remains
    }
  }
}
