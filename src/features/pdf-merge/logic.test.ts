import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { mergeFiles, mergePages } from './logic';

async function pdfWithSize(w: number, h: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([w, h]);
  page.drawText(`page ${w}×${h}`, { x: 50, y: 100, size: 12, font });
  return new Uint8Array(await doc.save());
}

/** Multi-page PDF with a distinct size per page — sizes prove ordering. */
async function pdfWithPages(sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [w, h] of sizes) {
    const page = doc.addPage([w, h]);
    page.drawText(`page ${w}×${h}`, { x: 50, y: 100, size: 12, font });
  }
  return new Uint8Array(await doc.save());
}

/** Minimal but structurally valid JPEG: SOI + APP1(EXIF o=1) + SOF0 + SOS + EOI. */
function syntheticJpeg(): Uint8Array<ArrayBuffer> {
  // SOF0: 640×480, 8-bit, RGB (3 components)
  const sof = [
    0xff,
    0xc0, // SOF0
    0x00,
    0x11, // length 17
    0x08, // 8-bit precision
    0x01,
    0xe0, // height 480
    0x02,
    0x80, // width 640
    0x03, // 3 components
    0x01,
    0x22,
    0x00, // Y
    0x02,
    0x11,
    0x00, // Cb
    0x03,
    0x11,
    0x00, // Cr
  ];
  const soi = [0xff, 0xd8];
  const sos = [0xff, 0xda, 0x00, 0x04, 0x00, 0x00];
  const eoi = [0xff, 0xd9];
  const buf = new Uint8Array([...soi, ...sof, ...sos, ...eoi] as number[]);
  return buf;
}

describe('mergeFiles', () => {
  it('merges PDFs and images in the given order', async () => {
    const a = await pdfWithSize(500, 600);
    const b = await pdfWithSize(700, 400);
    const jpeg = new File([syntheticJpeg()], 'photo.jpg', { type: 'image/jpeg' });

    const out = await mergeFiles(
      [
        { kind: 'pdf', name: 'a.pdf', bytes: a },
        { kind: 'image', name: 'photo.jpg', file: jpeg },
        { kind: 'pdf', name: 'b.pdf', bytes: b },
      ],
      { pageSize: 'a4', marginPt: 0 },
      () => {},
    );

    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);

    // Order check: distinct page sizes prove the arrangement (a, image→A4, b).
    const sizes = doc.getPages().map((p) => [p.getWidth(), p.getHeight()]);
    expect(sizes[0]).toEqual([500, 600]);
    expect(sizes[1]).toEqual([595.28, 841.89]); // A4 for the image
    expect(sizes[2]).toEqual([700, 400]);
  });

  it('requires at least one input', async () => {
    await expect(mergeFiles([], { pageSize: 'a4', marginPt: 0 }, () => {})).rejects.toThrow(
      /Nothing to merge/,
    );
  });

  it('fails with a friendly message for unreadable PDFs', async () => {
    const garbage = new TextEncoder().encode('this is not a pdf').buffer;
    await expect(
      mergeFiles(
        [{ kind: 'pdf', name: 'bad.pdf', bytes: new Uint8Array(garbage) }],
        { pageSize: 'a4', marginPt: 0 },
        () => {},
      ),
    ).rejects.toThrow(/bad\.pdf/);
  });
});

describe('mergePages (page-level reordering)', () => {
  it('copies individual pages in the exact arranged order, across files', async () => {
    const a = await pdfWithPages([
      [500, 600], // a.1
      [700, 400], // a.2
      [300, 300], // a.3
    ]);
    const b = await pdfWithPages([[800, 200]]); // b.1

    // arranged: a.3, b.1, a.1, a.2
    const out = await mergePages(
      [
        { kind: 'pdf', name: 'a.pdf', bytes: a, page: 3 },
        { kind: 'pdf', name: 'b.pdf', bytes: b, page: 1 },
        { kind: 'pdf', name: 'a.pdf', bytes: a, page: 1 },
        { kind: 'pdf', name: 'a.pdf', bytes: a, page: 2 },
      ],
      { pageSize: 'a4', marginPt: 0 },
      () => {},
    );

    const doc = await PDFDocument.load(out);
    const sizes = doc.getPages().map((p) => [p.getWidth(), p.getHeight()]);
    expect(sizes).toEqual([
      [300, 300],
      [800, 200],
      [500, 600],
      [700, 400],
    ]);
  });

  it('interleaves images between PDF pages', async () => {
    const a = await pdfWithPages([
      [500, 600],
      [700, 400],
    ]);
    const jpeg = new File([syntheticJpeg()], 'photo.jpg', { type: 'image/jpeg' });

    const out = await mergePages(
      [
        { kind: 'pdf', name: 'a.pdf', bytes: a, page: 1 },
        { kind: 'image', name: 'photo.jpg', file: jpeg },
        { kind: 'pdf', name: 'a.pdf', bytes: a, page: 2 },
      ],
      { pageSize: 'a4', marginPt: 0 },
      () => {},
    );

    const doc = await PDFDocument.load(out);
    const sizes = doc.getPages().map((p) => [p.getWidth(), p.getHeight()]);
    expect(sizes).toEqual([
      [500, 600],
      [595.28, 841.89], // A4 for the image
      [700, 400],
    ]);
  });

  it('rejects a page number outside the source', async () => {
    const a = await pdfWithPages([[500, 600]]);
    await expect(
      mergePages(
        [{ kind: 'pdf', name: 'a.pdf', bytes: a, page: 9 }],
        { pageSize: 'a4', marginPt: 0 },
        () => {},
      ),
    ).rejects.toThrow(/a\.pdf/);
  });

  it('loads each source document exactly once for interleaved page order', async () => {
    const a = await pdfWithPages([
      [500, 600], // a.1
      [700, 400], // a.2
    ]);
    const b = await pdfWithPages([
      [800, 200], // b.1
      [900, 100], // b.2
    ]);

    // pdflib() resolves to the same module instance, so the static load()
    // is spy-able. A1, B1, A2, B2 must parse each file exactly once.
    const loadSpy = vi.spyOn(PDFDocument, 'load');
    let out: Uint8Array;
    try {
      out = await mergePages(
        [
          { kind: 'pdf', name: 'a.pdf', bytes: a, page: 1 },
          { kind: 'pdf', name: 'b.pdf', bytes: b, page: 1 },
          { kind: 'pdf', name: 'a.pdf', bytes: a, page: 2 },
          { kind: 'pdf', name: 'b.pdf', bytes: b, page: 2 },
        ],
        { pageSize: 'a4', marginPt: 0 },
        () => {},
      );
      // assert before restore — mockRestore() also clears call history
      expect(loadSpy).toHaveBeenCalledTimes(2);
    } finally {
      loadSpy.mockRestore();
    }

    const doc = await PDFDocument.load(out);
    const sizes = doc.getPages().map((p) => [p.getWidth(), p.getHeight()]);
    expect(sizes).toEqual([
      [500, 600],
      [800, 200],
      [700, 400],
      [900, 100],
    ]);
  });

  it('requires at least one page', async () => {
    await expect(mergePages([], { pageSize: 'a4', marginPt: 0 }, () => {})).rejects.toThrow(
      /Nothing to merge/,
    );
  });
});
