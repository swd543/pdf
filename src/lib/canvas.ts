/**
 * Shared canvas bounds (browser-safety).
 *
 * PDF.js viewports can legally request absurd sizes (tall/wide pages, high
 * DPI, malformed mediaboxes). A canvas beyond GPU limits either fails or
 * silently degrades; better to bound deterministically and tell the caller.
 */
import { MAX_CANVAS_PX, MAX_CANVAS_SIDE } from './limits';

export interface BoundedCanvasSize {
  width: number;
  height: number;
  /** True when the requested size exceeded a cap and was scaled down. */
  reduced: boolean;
}

export interface CanvasCaps {
  maxPx?: number;
  maxSide?: number;
}

/**
 * Clamp a requested pixel size to the browser-safety caps, preserving the
 * aspect ratio. Never returns a zero or sub-pixel dimension.
 */
export function boundedCanvasSize(
  requestedWidth: number,
  requestedHeight: number,
  caps: CanvasCaps = {},
): BoundedCanvasSize {
  const maxPx = caps.maxPx ?? MAX_CANVAS_PX;
  const maxSide = caps.maxSide ?? MAX_CANVAS_SIDE;

  let w = Math.max(1, Math.round(requestedWidth));
  let h = Math.max(1, Math.round(requestedHeight));
  let reduced = false;

  const longest = Math.max(w, h);
  if (longest > maxSide) {
    const f = maxSide / longest;
    w = Math.max(1, Math.round(w * f));
    h = Math.max(1, Math.round(h * f));
    reduced = true;
  }

  if (w * h > maxPx) {
    const f = Math.sqrt(maxPx / (w * h));
    w = Math.max(1, Math.round(w * f));
    h = Math.max(1, Math.round(h * f));
    reduced = true;
  }

  return { width: w, height: h, reduced };
}

/** Release a canvas backing store immediately (idempotent). */
export function releaseCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): void {
  canvas.width = 0;
  canvas.height = 0;
}
