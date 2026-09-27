import { describe, expect, it } from 'vitest';
import {
  clampStampBox,
  fitStampToPage,
  looksLikeXfa,
  resizeStampBox,
} from '~/features/pdf-sign/logic';

describe('looksLikeXfa', () => {
  it('detects the /XFA marker in the document head', () => {
    const data = new TextEncoder().encode(
      '%PDF-1.7\n... <</Type /Catalog /Pages 2 0 R /XFA <</XML xref>> ...',
    );
    expect(looksLikeXfa(data.buffer as ArrayBuffer)).toBe(true);
  });
  it('returns false for ordinary PDFs', () => {
    const data = new TextEncoder().encode('%PDF-1.7\n<</Type /Catalog /Pages 2 0 R>>\n%%EOF');
    expect(looksLikeXfa(data.buffer as ArrayBuffer)).toBe(false);
  });
  it('handles empty buffers', () => {
    expect(looksLikeXfa(new ArrayBuffer(0))).toBe(false);
  });
});

describe('stamp geometry (point-space, page-bounded)', () => {
  // A4-ish page in PDF points.
  const W = 595;
  const H = 842;

  describe('clampStampBox', () => {
    it('keeps an in-bounds stamp where it was put', () => {
      expect(clampStampBox(W, H, 100, 200, 120, 60)).toEqual({ x: 100, y: 200 });
    });
    it('pulls a stamp back from the right and bottom edges', () => {
      // top-left at (590, 838) with 120x60 would overshoot both edges
      const c = clampStampBox(W, H, 590, 838, 120, 60);
      expect(c.x + 120).toBeLessThanOrEqual(W);
      expect(c.y + 60).toBeLessThanOrEqual(H);
    });
    it('clamps a stamp larger than the page to the origin', () => {
      expect(clampStampBox(W, H, 30, 30, W + 100, H + 100)).toEqual({ x: 0, y: 0 });
    });
    it('never returns negative coordinates', () => {
      const c = clampStampBox(W, H, -50, -50, 100, 100);
      expect(c.x).toBe(0);
      expect(c.y).toBe(0);
    });
  });

  describe('fitStampToPage', () => {
    it('leaves a stamp that already fits unchanged', () => {
      expect(fitStampToPage(W, H, 120, 60)).toEqual({ w: 120, h: 60 });
    });
    it('shrinks an oversized stamp preserving its aspect ratio', () => {
      const f = fitStampToPage(W, H, W * 2, 60 * 2); // 2x too wide
      expect(f.w).toBe(W);
      expect(f.h).toBeCloseTo(60, 5); // half of the 120
    });
    it('respects the page height too', () => {
      const f = fitStampToPage(W, H, 60, H * 2);
      expect(f.h).toBe(H);
      expect(f.w).toBeCloseTo(30, 5);
    });
    it('fits even on a page smaller than the normal minimum stamp size', () => {
      const f = fitStampToPage(20, 10, 120, 60);
      expect(f).toEqual({ w: 20, h: 10 });
    });
  });

  describe('resizeStampBox', () => {
    it('grows a stamp to the requested width preserving aspect', () => {
      const r = resizeStampBox(W, H, 50, 50, 100, 50, 200);
      expect(r.w).toBe(200);
      expect(r.h).toBeCloseTo(100, 5);
    });
    it('caps the width at the page edge to the right of the stamp', () => {
      const r = resizeStampBox(W, H, 400, 50, 100, 50, 500); // x + w > page
      expect(r.w + 400).toBeLessThanOrEqual(W);
    });
    it('enforces a minimum width', () => {
      const r = resizeStampBox(W, H, 50, 50, 100, 50, 5);
      expect(r.w).toBeGreaterThanOrEqual(40);
    });
    it('keeps the bottom edge on the page when tall', () => {
      const r = resizeStampBox(W, H, 50, 700, 100, 100, 400);
      expect(r.h + 700).toBeLessThanOrEqual(H);
    });
    it('never forces the normal minimum past a narrow page edge', () => {
      const r = resizeStampBox(20, 10, 0, 0, 20, 10, 100);
      expect(r.w).toBe(20);
      expect(r.h).toBe(10);
    });
  });
});
