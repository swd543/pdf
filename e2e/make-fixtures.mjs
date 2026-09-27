/**
 * E2E PDF fixtures — generated deterministically with pdf-lib.
 *
 * Run: node e2e/make-fixtures.mjs   (writes e2e/fixtures/*.pdf)
 *
 * Fixtures:
 *  - text-1p.pdf        A4 portrait, 24pt title + body, marker MARK-ONE
 *  - text-5p.pdf        5 pages, mixed sizes/orientations, unique markers,
 *                       varying heading sizes (heading-detection coverage)
 *  - image-heavy-3p.pdf 3 A4 pages, each dominated by a 480×360 noisy PNG
 *                       (incompressible raster → strong-compress shrink coverage)
 *                       (strong-compress shrink coverage)
 *  - form.pdf           AcroForm: 2 text fields, checkbox, dropdown
 *  - encrypted.pdf      user-password protected (negative tests)
 *  - landscape-1p.pdf   A4 landscape + marker MARK-LANDSCAPE
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import pdfLib from 'pdf-lib';

const { PDFDocument, StandardFonts } = pdfLib;

/** CRC32 (IEEE 802.3) — needed for PNG chunks; inline to stay dependency-free. */
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const OUT = path.join(import.meta.dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

/* ---------------- tiny PNG encoder (raw RGBA + raw deflate) ---------------- */

function png(w, h, pixel) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y += 1) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const i = y * (1 + w * 4) + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // NOTE: IDAT is zlib-wrapped (header + adler32) — this is what the UPNG fork
  // used by pdf-lib's PngEmbedder expects (it strips the 2-byte zlib header
  // and 4-byte adler before inflating).
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Deterministic per-pixel noise (incompressible → raster dominates size). */
const noise = (seed) => {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  return () => [Math.round(rnd() * 255), Math.round(rnd() * 255), Math.round(rnd() * 255), 255];
};

const A4 = [595.28, 841.89];
const LETTER = [612, 792];

async function save(name, doc) {
  const bytes = await doc.save();
  fs.writeFileSync(path.join(OUT, name), bytes);
  console.log(`  ${name.padEnd(20)} ${String(bytes.byteLength).padStart(8)} B`);
}

/* ---------------- fixtures ---------------- */

console.log('writing fixtures →', OUT);

// 1. text-1p.pdf
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage(A4);
  p.drawText('Quarterly Report', { x: 72, y: 760, size: 24, font: bold });
  p.drawText('This is MARK-ONE of the quarterly report.', { x: 72, y: 720, size: 11, font });
  p.drawText('Second line with more body text.', { x: 72, y: 706, size: 11, font });
  p.drawText('Third line, still body.', { x: 72, y: 666, size: 11, font });
  await save('text-1p.pdf', doc);
}

// 2. text-5p.pdf — mixed page sizes + heading sizes
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const p1 = doc.addPage(A4);
  p1.drawText('Title One', { x: 72, y: 760, size: 24, font: bold });
  p1.drawText('Body text, MARK-P1.', { x: 72, y: 720, size: 11, font });
  p1.drawText('Wrapped continuation of the same paragraph.', { x: 72, y: 706, size: 11, font });

  const p2 = doc.addPage(LETTER);
  p2.drawText('Heading Two', { x: 72, y: 720, size: 18, font: bold });
  p2.drawText('Letter-sized page with MARK-P2 body.', { x: 72, y: 680, size: 11, font });

  const p3 = doc.addPage([400, 400]);
  p3.drawText('Square page. MARK-P3 only body size.', { x: 40, y: 360, size: 11, font });

  const p4 = doc.addPage([841.89, 595.28]); // A4 landscape
  p4.drawText('Landscape page MARK-P4.', { x: 72, y: 520, size: 11, font });

  const p5 = doc.addPage([300, 200]);
  p5.drawText('Small page', { x: 40, y: 160, size: 20, font: bold });
  p5.drawText('MARK-P5 body.', { x: 40, y: 130, size: 11, font });

  await save('text-5p.pdf', doc);
}

// 3. image-heavy-3p.pdf — big raster images dominate the size
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const W = 480,
    H = 360;
  const fills = [noise(1), noise(2), noise(3)];
  for (let n = 0; n < 3; n += 1) {
    const imgPng = png(W, H, fills[n]);
    const img = await doc.embedPng(imgPng);
    const p = doc.addPage(A4);
    // Cover most of the page: 500pt wide × 375pt high.
    p.drawImage(img, { x: 48, y: 60, width: 500, height: 375 });
    p.drawText(`IMG-P${n + 1} caption under the big image.`, { x: 48, y: 40, size: 11, font });
  }
  await save('image-heavy-3p.pdf', doc);
}

// 4. form.pdf — AcroForm coverage
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage(A4);
  p.drawText('Application form', { x: 50, y: 780, size: 20, font });
  const form = doc.getForm();
  const name = form.createTextField('name');
  name.addToPage(p, { x: 50, y: 700, width: 240, height: 24 });
  const email = form.createTextField('email');
  email.addToPage(p, { x: 50, y: 660, width: 240, height: 24 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(p, { x: 50, y: 620, width: 20, height: 20 });
  const country = form.createDropdown('country');
  country.addOptions(['AT', 'DE', 'FR']);
  country.addToPage(p, { x: 90, y: 620, width: 120, height: 24 });
  await save('form.pdf', doc);
}

// 5. encrypted.pdf — user-password protected (negative tests).
//    pdf-lib has no working encryptor, so this is normally built with
//    Ghostscript (`gs`) — but the *committed* fixture (e2e/fixtures/
//    encrypted.pdf) is used whenever present, because Ghostscript output
//    varies between versions and a byte-stable negative fixture keeps the
//    E2E suite identical on every machine. gs is only the fallback for
//    fresh clones that lost the committed file.
{
  const out = path.join(OUT, 'encrypted.pdf');
  if (!fs.existsSync(out)) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage(A4).drawText('Secret MARK-ENC content.', { x: 72, y: 760, size: 11, font });
    const src = path.join(OUT, '.tmp-enc-src.pdf');
    fs.writeFileSync(src, await doc.save());
    await new Promise((res, rej) => {
      execFile(
        'gs',
        [
          '-dNOPAUSE',
          '-dBATCH',
          '-sDEVICE=pdfwrite',
          '-sUserPassword=secret123',
          '-sOwnerPassword=owner123',
          '-q',
          '-o',
          out,
          src,
        ],
        (e) =>
          e
            ? rej(
                new Error(
                  `Ghostscript (gs) is required to build the encrypted fixture: ${e.message}`,
                ),
              )
            : res(),
      );
    });
    fs.rmSync(src, { force: true });
    console.log(
      `  ${'encrypted.pdf'.padEnd(20)} ${String(fs.statSync(out).size).padStart(8)} B  (gs-encrypted)`,
    );
  }
}

// 6. landscape-1p.pdf
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage([841.89, 595.28]);
  p.drawText('Wide Sheet', { x: 72, y: 520, size: 24, font: bold });
  p.drawText('Landscape MARK-LANDSCAPE body text.', { x: 72, y: 480, size: 11, font });
  await save('landscape-1p.pdf', doc);
}

console.log('done');
