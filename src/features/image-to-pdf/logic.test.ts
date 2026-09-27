import { describe, expect, it } from 'vitest';
import { imagePageDimensions, PAGE_SIZES } from './logic';

describe('imagePageDimensions', () => {
  it('fit: scales image pixels 96dpi → 72dpi (PDF points)', () => {
    expect(imagePageDimensions(960, 600, 'fit')).toEqual([720, 450]);
    expect(imagePageDimensions(800, 600, 'fit')).toEqual([600, 450]);
  });

  it('fit: clamps to the 72pt minimum', () => {
    const [w, h] = imagePageDimensions(1, 1, 'fit');
    expect(w).toBe(72);
    expect(h).toBe(72);
  });

  it('fit: clamps to the 14400pt maximum per side', () => {
    const [w, h] = imagePageDimensions(100_000, 50_000, 'fit');
    expect(w).toBe(14400);
    expect(h).toBe(14400);
  });

  it('fixed sizes ignore the image dimensions', () => {
    expect(imagePageDimensions(100, 100, 'a4')).toEqual(PAGE_SIZES.a4);
    expect(imagePageDimensions(100, 100, 'letter')).toEqual(PAGE_SIZES.letter);
    expect(imagePageDimensions(100, 100, 'legal')).toEqual(PAGE_SIZES.legal);
  });
});
