import { describe, expect, it } from 'vitest';
import { boundedCanvasSize } from '~/lib/canvas';

describe('boundedCanvasSize', () => {
  it('passes through normal page sizes untouched', () => {
    // A4 @ 300dpi ≈ 2480 × 3508 → ~8.7 MP, under both caps.
    const r = boundedCanvasSize(2480, 3508);
    expect(r).toEqual({ width: 2480, height: 3508, reduced: false });
  });

  it('clamps the long side to MAX_CANVAS_SIDE', () => {
    const r = boundedCanvasSize(200, 100_000);
    expect(r.reduced).toBe(true);
    expect(r.height).toBe(8192);
    expect(r.width).toBeLessThan(200); // aspect preserved
    expect(r.width * r.height).toBeLessThanOrEqual(12_000_000);
  });

  it('clamps total pixels to MAX_CANVAS_PX while keeping aspect', () => {
    // 6000 × 4000 = 24 MP → scale by sqrt(12/24) = 0.7071…
    const r = boundedCanvasSize(6000, 4000);
    expect(r.reduced).toBe(true);
    expect(r.width * r.height).toBeLessThanOrEqual(12_000_000);
    // aspect preserved (ratio within rounding)
    expect(r.width / r.height).toBeCloseTo(1.5, 1);
  });

  it('never returns zero or sub-pixel dimensions', () => {
    const r = boundedCanvasSize(0.2, 0.1);
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });

  it('honors custom caps', () => {
    const r = boundedCanvasSize(4000, 4000, { maxPx: 1_000_000, maxSide: 1000 });
    expect(r.reduced).toBe(true);
    expect(r.width).toBeLessThanOrEqual(1000);
    expect(r.height).toBeLessThanOrEqual(1000);
    expect(r.width * r.height).toBeLessThanOrEqual(1_000_000);
  });
});
