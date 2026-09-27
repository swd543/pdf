/**
 * Browser-safety limits for interactive work.
 *
 * PDF *processing* itself is streaming and yields to the browser, but page
 * pickers, reorder strips and page canvases allocate real resources per
 * page. Bounding those keeps a malformed or enormous PDF from freezing a
 * phone instead of failing it. Limits are intentionally conservative;
 * change them only with a documented benchmark (see
 * docs/ARCHITECTURE-PERFORMANCE-HANDOFF.md §6).
 */

/** Max pages the interactive re-order/picker views may hold in the DOM. */
export const MAX_INTERACTIVE_PAGES = 500;

/** Max rendered page thumbnails kept per tool session (global, not per file). */
export const MAX_PAGE_THUMBNAILS = 200;

/**
 * Max canvas area in pixels. Chromium's own raster caps (~16 MP) are higher,
 * but 12 MP keeps long-scan pages well inside mobile GPU budgets.
 */
export const MAX_CANVAS_PX = 12_000_000;

/** Max canvas side in pixels (covers GPUs with a lower per-side limit). */
export const MAX_CANVAS_SIDE = 8192;

/** Max concurrent full-resolution page canvases the Sign stage may keep. */
export const MAX_SIGNED_PAGE_CANVASES = 5;

/**
 * Max total input bytes a tool may hold eagerly in memory. The browser
 * already owns the `File` objects; anything beyond this must be re-read
 * from the File at operation time (or rejected up front).
 */
export const MAX_EAGER_INPUT_BYTES = 250 * 1024 * 1024;
