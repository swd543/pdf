import { describe, expect, it } from 'vitest';
import { recommendMode } from './logic';

/** A raw PDF-ish byte string with N embedded image XObjects. */
function fakePdf({
  img = 0,
  pages = 1,
  kbPerPage = 100,
}: {
  img?: number;
  pages?: number;
  kbPerPage?: number;
} = {}): Uint8Array {
  const imgs = Array.from({ length: img }, () => '/Subtype /Image /Length 123456').join('\n');
  const pad = 'x'.repeat(Math.max(0, kbPerPage * pages * 1024 - imgs.length - 200));
  const body = `%PDF-1.5\n${'obj'.repeat(pages)}\n${imgs}\n${pad}\n%%EOF`;
  return new TextEncoder().encode(body);
}

describe('recommendMode', () => {
  it('recommends lossless for a pure text/vector document', () => {
    const r = recommendMode(fakePdf({ img: 0, pages: 8, kbPerPage: 30 }), 8);
    expect(r.mode).toBe('lossless');
    expect(r.reason).toMatch(/text\/vector/);
  });

  it('recommends strong for an image-heavy document', () => {
    const bytes = fakePdf({ img: 12, pages: 3, kbPerPage: 400 });
    const r = recommendMode(bytes, 3);
    expect(r.mode).toBe('strong');
    expect(r.reason).toMatch(/image-heavy/);
    expect(r.reason).toContain('12 image streams');
  });

  it('keeps lossless when images exist but are tiny', () => {
    const r = recommendMode(fakePdf({ img: 3, pages: 3, kbPerPage: 8 }), 3);
    expect(r.mode).toBe('lossless');
    expect(r.reason).toMatch(/small/i);
  });

  it('keeps lossless for vector documents with a few images', () => {
    const r = recommendMode(fakePdf({ img: 1, pages: 10, kbPerPage: 60 }), 10);
    expect(r.mode).toBe('lossless');
    expect(r.reason).toMatch(/mostly vector/);
  });

  it('defers to lossless when the page count is unknown', () => {
    const r = recommendMode(fakePdf({ img: 4, pages: 4 }), 0);
    expect(r.mode).toBe('lossless');
  });
});
