/**
 * Lazy loader for Mozilla PDF.js (pdfjs-dist).
 *
 * PDF.js is the heaviest dependency (~300 KB gzipped + worker), so it is
 * only loaded on demand via dynamic import — each tool page code-splits it
 * into its own chunk, and the worker starts only when a file is opened.
 */
type PdfjsLib = typeof import('pdfjs-dist');

/**
 * pdfjs 6 computes a document fingerprint during every getDocument() using
 * `Uint8Array.prototype.toHex()` — a Baseline-2025 feature (Chrome 140+,
 * Firefox 133+, Safari 18.2+, Node 26+). On older engines (some Android
 * WebViews, older Node) it is missing and every document load throws
 * "toHex is not a function". Patch it in once, before pdfjs is imported.
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
 * pdfjs 6's render path (page.render / getOperatorList) calls
 * `Map.prototype.getOrInsertComputed()` — a recent V8/Node API (Node 26+)
 * that older engines (Node 24, some mobile browsers such as Samsung
 * Internet) lack. Without it every page.render() throws
 * "getOrInsertComputed is not a function" and pages render blank. Patch it
 * in once, before pdfjs is imported (same approach as the toHex shim above).
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

let libPromise: Promise<PdfjsLib> | null = null;

export function pdfjs(): Promise<PdfjsLib> {
  if (!libPromise) {
    libPromise = (async () => {
      const [lib, worker] = await Promise.all([
        import('pdfjs-dist'),
        // `?url` makes Vite emit the worker as a plain asset (hashed name);
        // this avoids `new Worker(new URL(...))` bundling quirks.
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);

      // One shared module worker for the page's lifetime.
      lib.GlobalWorkerOptions.workerPort = new Worker(worker.default, {
        type: 'module',
        credentials: 'same-origin',
      });

      return lib;
    })().catch((err) => {
      libPromise = null; // allow retry after a transient failure
      throw err;
    });
  }
  return libPromise;
}

/**
 * Open a PDF document with the site's font/cmap configuration.
 * (PDF.js v6 passes cMapUrl & standardFontDataUrl per-document.)
 * CMaps + standard fonts are copied to the site root by
 * scripts/copy-assets.mjs; only fetched by the worker when a document
 * actually needs them (most Latin documents never touch them).
 */
export async function pdfDocument(
  data: Uint8Array,
): Promise<import('pdfjs-dist').PDFDocumentProxy> {
  const lib = await pdfjs();
  await pendingDestroy; // never race an in-flight worker teardown
  return lib.getDocument({
    data,
    cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
  }).promise;
}

/** Destroy chain: pdfjs workers must be fully torn down before a new
 *  `getDocument` reuses them, or the new open fails with
 *  "the worker is being destroyed". We serialize every destroy before the
 *  next open so fire-and-forget disposePdf() call sites stay safe. */
let pendingDestroy: Promise<void> = Promise.resolve();

/** Release a document opened via pdfDocument (frees worker memory). */
export function disposePdf(pdf: import('pdfjs-dist').PDFDocumentProxy): Promise<void> {
  const done = pdf.loadingTask.destroy();
  pendingDestroy = pendingDestroy.then(() => done);
  return done;
}
