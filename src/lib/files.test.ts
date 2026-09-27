import { describe, expect, it } from 'vitest';
import { cleanFileName, humanSize, percentSaved } from '~/lib/files';

describe('humanSize', () => {
  it('formats bytes below 1 KB', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(1023)).toBe('1023 B');
  });
  it('formats KB/MB/GB with sensible precision', () => {
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(3072)).toBe('3.0 KB');
    expect(humanSize(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(humanSize(1536 * 1024 * 1024)).toBe('1.5 GB');
    expect(humanSize(256 * 1024)).toBe('256 KB');
    expect(humanSize(2560 * 1024)).toBe('2.5 MB');
  });
  it('rejects nonsense input', () => {
    expect(humanSize(-1)).toBe('-');
    expect(humanSize(Number.NaN)).toBe('-');
  });
});

describe('percentSaved', () => {
  it('computes savings percentage', () => {
    expect(percentSaved(200, 100)).toBe(50);
    expect(percentSaved(100, 100)).toBe(0);
    expect(percentSaved(100, 150)).toBe(-50);
  });
  it('guards zero original size', () => {
    expect(percentSaved(0, 100)).toBe(0);
  });
});

describe('cleanFileName', () => {
  it('strips drive paths from dragged files', () => {
    expect(cleanFileName('C:\\Users\\me\\doc.pdf')).toBe('doc.pdf');
    expect(cleanFileName('/home/me/doc.pdf')).toBe('doc.pdf');
    expect(cleanFileName('doc.pdf')).toBe('doc.pdf');
    expect(cleanFileName('')).toBe('file');
  });
});
