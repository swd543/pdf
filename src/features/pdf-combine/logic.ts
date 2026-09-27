/**
 * Combine pages ("n-up") logic.
 *
 * The user selects n pages from a PDF and picks a per-sheet grid
 * (2-up … 16-up); the n pages flow onto m = ceil(n / cells) sheets.
 *
 * Implementation note: pdf-lib cannot draw one page's *vector* content
 * inside another page (no Form-XObject embedding API), so placement is
 * done at high resolution through PDF.js rendering onto a canvas — the
 * same engine the PDF→image tool uses. Text on the combined sheets is
 * therefore rasterized (see docs/ARCHITECTURE.md for the vector
 * roadmap item).
 *
 * Pure layout math (sheetCount, perSheetCounts, cellLayout) is exported
 * and unit-tested in Node; the compositing itself needs DOM canvases.
 */
import { canvasToJpeg } from '~/lib/imaging';
import { disposePdf, pdfDocument } from '~/lib/pdfjs';
import { pdflib } from '~/lib/pdflib';
import { type ProgressFn, yieldToBrowser } from '~/lib/types';

export interface GridOption {
  id: string;
  cols: number;
  rows: number;
  label: string;
}

/** Per-sheet grids offered in the UI (pages flow top→bottom, left→right). */
export const GRIDS: GridOption[] = [
  { id: '2', cols: 1, rows: 2, label: '2-up (1 × 2)' },
  { id: '4', cols: 2, rows: 2, label: '4-up (2 × 2)' },
  { id: '6', cols: 2, rows: 3, label: '6-up (2 × 3)' },
  { id: '9', cols: 3, rows: 3, label: '9-up (3 × 3)' },
  { id: '16', cols: 4, rows: 4, label: '16-up (4 × 4)' },
];

export interface CombineOptions {
  cols: number;
  rows: number;
  /** Sheet size in PDF points (A4 portrait: 595.28 × 841.89). */
  sheetW: number;
  sheetH: number;
  /** Target sheet resolution in DPI (72 = native). */
  dpi: number;
}

/** Number of sheets m that n pages fill: ceil(n / cells). */
export function sheetCount(nPages: number, cells: number): number {
  if (nPages <= 0) return 0;
  return Math.ceil(nPages / cells);
}

/** Pages per sheet, e.g. 13 pages @ 4-up → [4, 4, 4, 1]. */
export function perSheetCounts(nPages: number, cells: number): number[] {
  const out: number[] = [];
  for (let left = nPages; left > 0; left -= cells) {
    out.push(Math.min(cells, left));
  }
  return out;
}

export interface CellLayout {
  /** Scale factor from page units to cell units. */
  scale: number;
  /** Draw position/size inside the cell (cell coordinates, top-left origin). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fit a page (pw × ph) into a cell (cw × ch), centered. */
export function cellLayout(pw: number, ph: number, cw: number, ch: number): CellLayout {
  const scale = Math.min(cw / pw, ch / ph);
  const w = pw * scale;
  const h = ph * scale;
  return { scale, x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

/** Sheets are JPEG-embedded; 0.85 is a good size/quality trade for pages. */
const SHEET_JPEG_QUALITY = 0.85;
/** Memory guard: A4 @ 200 dpi ≈ 1240 × 1754 px; cap the long side. */
const MAX_SHEET_PX = 2600;

/**
 * Draw one combined sheet (cells × rows) into a canvas.
 * Shared by the real output (`combinePages`, full resolution) and the
 * live preview (`previewSheets`, low resolution) so both show exactly
 * the same layout.
 */
async function drawSheet(
  pdf: Awaited<ReturnType<typeof pdfDocument>>,
  selected: number[],
  sheet: number,
  count: number,
  cols: number,
  rows: number,
  ppi: number,
  canvasW: number,
  canvasH: number,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(canvasW));
  canvas.height = Math.max(1, Math.round(canvasH));
  const ctx = canvas.getContext('2d', { desynchronized: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cellW = canvas.width / cols;
  const cellH = canvas.height / rows;
  let pageIdx = sheet * (cols * rows);

  for (let k = 0; k < count; k += 1) {
    const pageNum = selected[pageIdx]!;
    pageIdx += 1;
    const page = await pdf.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const layout = cellLayout(base.width, base.height, cellW, cellH);
    const viewport = page.getViewport({ scale: layout.scale * ppi });

    const tile = document.createElement('canvas');
    tile.width = Math.max(1, Math.ceil(viewport.width));
    tile.height = Math.max(1, Math.ceil(viewport.height));
    const tctx = tile.getContext('2d', { desynchronized: true });
    if (!tctx) throw new Error('Canvas 2D context unavailable');
    await page.render({ canvas: tile, viewport }).promise;

    const col = k % cols;
    const row = Math.floor(k / cols);
    ctx.drawImage(
      tile,
      Math.round(col * cellW + layout.x),
      Math.round(row * cellH + layout.y),
      Math.round(layout.w),
      Math.round(layout.h),
    );
    tile.width = 0;
    tile.height = 0; // release the tile backing store
  }
  return canvas;
}

/**
 * Live preview: render the first `maxSheets` output sheets at low
 * resolution (same layout math as the real output) and return JPEG data
 * URLs. Browser-only; cheap enough to run on every option change.
 */
export async function previewSheets(
  data: ArrayBuffer,
  selected: number[],
  options: Omit<CombineOptions, 'dpi'>,
  maxSheets = 3,
  targetWidth = 260,
): Promise<{ urls: string[]; total: number }> {
  if (selected.length === 0) return { urls: [], total: 0 };
  const cells = options.cols * options.rows;
  const counts = perSheetCounts(selected.length, cells);
  const total = counts.length;
  const ppi = targetWidth / (options.sheetW / 72); // preview scale
  const canvasH = (options.sheetH / options.sheetW) * targetWidth;

  const pdf = await pdfDocument(new Uint8Array(data));
  const urls: string[] = [];
  try {
    const n = Math.min(maxSheets, total);
    for (let s = 0; s < n; s += 1) {
      const canvas = await drawSheet(
        pdf,
        selected,
        s,
        counts[s]!,
        options.cols,
        options.rows,
        ppi,
        targetWidth,
        canvasH,
      );
      urls.push(canvas.toDataURL('image/jpeg', 0.7));
      canvas.width = 0;
      canvas.height = 0;
      await yieldToBrowser();
    }
    return { urls, total };
  } finally {
    disposePdf(pdf);
  }
}

/**
 * Combine the selected pages (1-based, in the given order) into sheets.
 * Browser-only (needs DOM canvases); reports progress per sheet.
 */
export async function combinePages(
  data: ArrayBuffer,
  selected: number[],
  options: CombineOptions,
  onProgress: ProgressFn,
): Promise<Uint8Array> {
  if (selected.length === 0) throw new Error('Select at least one page to combine.');
  const cells = options.cols * options.rows;
  const counts = perSheetCounts(selected.length, cells);
  const sheets = counts.length;

  // Clamp the effective DPI so the sheet canvas stays within memory budget.
  let dpi = options.dpi;
  const sheetPx = (options.sheetW / 72) * dpi;
  while (sheetPx > MAX_SHEET_PX && dpi > 72) {
    dpi = Math.max(72, Math.round(dpi * 0.85));
  }
  const ppi = dpi / 72; // pixels per PDF point

  const pdf = await pdfDocument(new Uint8Array(data));
  try {
    const { PDFDocument } = await pdflib();
    const out = await PDFDocument.create();
    out.setTitle('Combined pages');
    out.setProducer('PDFBoogie (in-browser, no upload)');

    for (let s = 0; s < sheets; s += 1) {
      onProgress(s, sheets, `Sheet ${s + 1} of ${sheets}…`);
      await yieldToBrowser();
      const n = counts[s]!;

      const canvas = await drawSheet(
        pdf,
        selected,
        s,
        n,
        options.cols,
        options.rows,
        ppi,
        (options.sheetW / 72) * dpi,
        (options.sheetH / 72) * dpi,
      );

      const jpeg = await canvasToJpeg(canvas, SHEET_JPEG_QUALITY);
      canvas.width = 0;
      canvas.height = 0;

      const img = await out.embedJpg(jpeg);
      out.addPage([options.sheetW, options.sheetH]).drawImage(img, {
        x: 0,
        y: 0,
        width: options.sheetW,
        height: options.sheetH,
      });
      onProgress(s + 1, sheets, `Sheet ${s + 1} of ${sheets} done`);
      await yieldToBrowser();
    }

    onProgress(sheets, sheets, 'Assembling PDF');
    return out.save();
  } finally {
    disposePdf(pdf);
  }
}
