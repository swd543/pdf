/**
 * Live-site smoke + functional test against https://pdf.bugaboxes.com.
 *
 * Real user flows: native file inputs (setInputFiles), CTA clicks, download
 * capture, Node-side validation of every artifact (PDF magic + page count via
 * pdfjs, ZIP entries, PNG/JPEG magics). One page context per flow.
 *
 *   pnpm test:fixtures          # generate e2e fixtures first (needs ghostscript)
 *   node scripts/live-check.mjs   # run against https://pdf.bugaboxes.com
 *
 * No assertions run in CI — this is a manual smoke/functional check against
 * the deployed site (real uploads, real downloads, Node-side validation).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const BASE = 'https://pdf.bugaboxes.com';
const FX = join(process.cwd(), 'e2e', 'fixtures');
const OUT = '/home/buga/tmp/live-out';
mkdirSync(OUT, { recursive: true });

const results = [];
const adRequests = [];
const pageErrors = [];
function ok(name, detail = '') {
  results.push({ name, pass: true });
  console.log(`PASS  ${name} ${detail}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false });
  console.log(`FAIL  ${name} ${detail}`);
}

/* ---------------- validators ------------------------------------------ */
const fx = (n) => join(FX, n);
const isPdf = (b) => b.subarray(0, 5).toString() === '%PDF-' && b.includes('%%EOF');
const isPng = (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8;
const isZip = (b) => b.subarray(0, 4).toString('latin1') === 'PK\x03\x04';
function zipEntries(b) {
  // fflate: proper inflation, no manual header parsing
  const unzipped = unzipSync(new Uint8Array(b));
  return Object.entries(unzipped).map(([name, data]) => ({ name, data }));
}
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { unzipSync } = await import('fflate');
async function pageCount(b) {
  const task = pdfjs.getDocument({ data: new Uint8Array(b.slice(0)) });
  const doc = await task.promise;
  const n = doc.numPages;
  await task.destroy();
  return n;
}

/* ---------------- browser --------------------------------------------- */
// Late "Target page ... closed" rejections from abandoned download promises
// must not kill the run.
process.on('unhandledRejection', (e) => {
  if (!/closed|crashed/i.test(String(e))) console.log('UNHANDLED:', e);
});

const browser = await chromium.launch();
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1280, height: 900 },
});
context.on('request', (r) => {
  if (r.url().includes('googlesyndication.com') || r.url().includes('doubleclick.net'))
    adRequests.push(r.url());
});

async function flow(name, fn) {
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
  try {
    await fn(page);
  } catch (e) {
    fail(name, e.message.split('\n')[0]);
  } finally {
    try {
      await page.close();
    } catch {
      /* already closed */
    }
  }
}

/* 1. Merge (2 PDFs) ------------------------------------------------------ */
await flow('merge 2 PDFs', async (page) => {
  await page.goto(`${BASE}/pdf-merge`, { waitUntil: 'networkidle' });
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([fx('text-5p.pdf'), fx('text-1p.pdf')]);
  const cta = page.getByRole('button', { name: 'Merge 6 pages into one PDF' });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await cta.click();
  await page.locator('.result-card').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const p = join(OUT, 'merge.pdf');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const n = await pageCount(b);
  if (isPdf(b) && n === 6) ok('merge', `6 pages (5+1), ${(b.length / 1024).toFixed(0)} KB`);
  else fail('merge', `valid=${isPdf(b)} pages=${n}`);
});

/* 2. Compress lossless --------------------------------------------------- */
await flow('compress lossless (1.5 MB image PDF)', async (page) => {
  const input = readFileSync(fx('image-heavy-3p.pdf'));
  await page.goto(`${BASE}/pdf-compress`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('image-heavy-3p.pdf'));
  const cta = page.getByRole('button', { name: 'Compress (lossless)' });
  // regression: the mode toggle's knob must not overlay its label text
  const toggleOk = await page.evaluate(() => {
    const label = document.querySelector('.toggle');
    if (!label) return false;
    const knob = label.querySelector('.knob').getBoundingClientRect();
    const text = label.querySelector('span:last-child').getBoundingClientRect();
    return (
      getComputedStyle(label).display === 'inline-flex' &&
      knob.width > 20 &&
      text.x >= knob.right - 1
    );
  });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await cta.click();
  await page.locator('.result-card').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const p = join(OUT, 'compress-lossless.pdf');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const n = await pageCount(b);
  // CSP must permit the WASM core (was silently falling back to JS before)
  const wasmBadge = await page.locator('text=Rust/WASM core').count();
  const jsBadge = await page.locator('text=JS fallback').count();
  // Lossless re-save must not meaningfully grow the file (±0.1%/256 B noise).
  const sizeOk = b.length <= input.length + Math.max(256, Math.floor(input.length * 0.001));
  const saved = (100 - (100 * b.length) / input.length).toFixed(1);
  const sizeMsg =
    b.length < input.length
      ? `${saved}% smaller`
      : 'no meaningful change (already dense — expected; keep original)';
  if (isPdf(b) && n === 3 && sizeOk && wasmBadge > 0 && jsBadge === 0 && toggleOk)
    ok('compress-lossless', `3 pages, ${sizeMsg} (${(b.length / 1024).toFixed(0)} KB)`);
  else
    fail(
      'compress-lossless',
      `valid=${isPdf(b)} pages=${n} wasm=${wasmBadge} js=${jsBadge} toggle=${toggleOk} in=${input.length} out=${b.length}`,
    );
});

/* 3. Compress strong ------------------------------------------------------ */
await flow('compress strong (JPEG re-encode)', async (page) => {
  await page.goto(`${BASE}/pdf-compress`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('image-heavy-3p.pdf'));
  await page.locator('label', { hasText: 'Strong compression' }).click();
  const cta = page.getByRole('button', { name: 'Compress (strong)' });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  const dl = page.waitForEvent('download', { timeout: 90000 });
  await cta.click();
  await page.locator('.result-card').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const p = join(OUT, 'compress-strong.pdf');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const n = await pageCount(b);
  if (isPdf(b) && n === 3) ok('compress-strong', `3 pages, ${(b.length / 1024).toFixed(0)} KB`);
  else fail('compress-strong', `valid=${isPdf(b)} pages=${n}`);
});

/* 4. Combine pages (5 → 4-up → 2 sheets) ---------------------------------- */
await flow('combine 5 pages 4-up', async (page) => {
  await page.goto(`${BASE}/pdf-combine`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('text-5p.pdf'));
  const tiles = page.locator('.page-tile');
  // default state = all pages selected
  await tiles.first().waitFor({ state: 'visible', timeout: 30000 });
  const pressed0 = await page.locator('.page-tile[aria-pressed="true"]').count();
  if (pressed0 !== 5) throw new Error(`expected 5 preselected tiles, got ${pressed0}`);
  const cta = page.getByRole('button', { name: 'Combine 5 pages' });
  try {
    await cta.waitFor({ state: 'visible', timeout: 20000 });
  } catch (e) {
    const ctas = await page
      .locator('button.btn-primary')
      .allTextContents()
      .catch(() => []);
    const pressed = await page
      .locator('.page-tile[aria-pressed="true"]')
      .count()
      .catch(() => -1);
    throw new Error(`CTA not found. ctas=${JSON.stringify(ctas)} pressedTiles=${pressed}`);
  }
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await cta.click();
  await page.locator('.result-card').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const p = join(OUT, 'combine-4up.pdf');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const n = await pageCount(b);
  if (isPdf(b) && n === 2) ok('combine-4up', '5 pages → 2 sheets');
  else fail('combine-4up', `valid=${isPdf(b)} pages=${n}`);
});

/* 5. Image → PDF (PNG + BMP + JPEG) -------------------------------------- */
await flow('image-to-pdf (3 formats)', async (page) => {
  await page.goto(`${BASE}/image-to-pdf`, { waitUntil: 'networkidle' });
  // Generate guaranteed-valid images in a scratch page (canvas export),
  // then verify each decodes before uploading through the real file input.
  const scratch = await context.newPage();
  const gen = (type, w, h, css) =>
    scratch.evaluate(
      async ([t, width, height, fill]) => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d');
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, width, height);
        const blob = await new Promise((res) => c.toBlob(res, t));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      },
      [type, w, h, css],
    );
  const pngBytes = await gen('image/png', 320, 180, '#c8451f');
  const jpgBytes = await gen('image/jpeg', 320, 180, '#1e64c8');
  const webpBytes = await gen('image/webp', 320, 180, '#2e9e4f');
  const decodable = (bytes, type) =>
    scratch.evaluate(
      async ([b, t]) => {
        const blob = new Blob([new Uint8Array(b)], { type: t });
        try {
          await createImageBitmap(blob);
          return true;
        } catch {
          return false;
        }
      },
      [bytes, type],
    );
  for (const [name, bytes, type] of [
    ['t1.png', pngBytes, 'image/png'],
    ['t2.jpg', jpgBytes, 'image/jpeg'],
    ['t3.webp', webpBytes, 'image/webp'],
  ]) {
    if (!(await decodable(bytes, type))) {
      await scratch.close();
      fail('image-to-pdf', `generated ${name} does not decode`);
      return;
    }
  }
  await scratch.close();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([
      { name: 't1.png', mimeType: 'image/png', buffer: Buffer.from(pngBytes) },
      { name: 't2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpgBytes) },
      { name: 't3.webp', mimeType: 'image/webp', buffer: Buffer.from(webpBytes) },
    ]);
  const cta = page.getByRole('button', { name: 'Combine 3 images into a PDF' });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await cta.click();
  await page.locator('.result-card').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const p = join(OUT, 'images-to-pdf.pdf');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const n = await pageCount(b);
  if (isPdf(b) && n === 3) ok('image-to-pdf', '3 images → 3-page PDF');
  else fail('image-to-pdf', `valid=${isPdf(b)} pages=${n}`);
});

/* 6. PDF → image, range 2–4 as JPEG ZIP ------------------------------------ */
await flow('pdf-to-image pages 2-4 JPEG (ZIP)', async (page) => {
  await page.goto(`${BASE}/pdf-to-image`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('text-5p.pdf'));
  await page.locator('[aria-label="First page"]').fill('2');
  await page.locator('[aria-label="Last page"]').fill('4');
  await page.locator('#fmt').selectOption('jpeg');
  const cta = page.getByRole('button', { name: /Convert pages 2[\u2013-]4 \(3\) to JPEG/ });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await cta.click();
  await page.locator('.result-card').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const p = join(OUT, 'pages-2-4.zip');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const entries = isZip(b) ? zipEntries(b) : [];
  const jpegs = entries.filter((e) => isJpeg(Buffer.from(e.data)));
  if (jpegs.length === 3)
    ok('pdf-to-image zip', `3 JPEG entries (${entries.map((e) => e.name).join(', ')})`);
  else fail('pdf-to-image zip', `zip=${isZip(b)} entries=${entries.length} jpegs=${jpegs.length}`);
});

/* 7. PDF → image, single page PNG (direct file) ---------------------------- */
await flow('pdf-to-image page 3 PNG (direct)', async (page) => {
  await page.goto(`${BASE}/pdf-to-image`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('text-5p.pdf'));
  await page.locator('[aria-label="First page"]').fill('3');
  await page.locator('[aria-label="Last page"]').fill('3');
  await page.locator('#fmt').selectOption('png');
  const cta = page.getByRole('button', { name: /Convert page 3 to PNG/ });
  try {
    await cta.waitFor({ state: 'visible', timeout: 20000 });
  } catch (e) {
    const alert =
      (await page
        .locator('[role="alert"]')
        .textContent()
        .catch(() => '')) || '';
    const ctas = await page.locator('button.btn-primary').allTextContents();
    throw new Error(`CTA not found. alert=${alert} ctas=${JSON.stringify(ctas)}`);
  }
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await cta.click();
  await page.locator('.result-card').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const p = join(OUT, 'page-3.png');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  if (isPng(b)) ok('pdf-to-image single', `PNG ${(b.length / 1024).toFixed(0)} KB`);
  else fail('pdf-to-image single', `png=${isPng(b)} zip=${isZip(b)}`);
});

/* 8. PDF → DOCX + ODT ------------------------------------------------------ */
await flow('pdf-to-docx', async (page) => {
  await page.goto(`${BASE}/pdf-to-doc`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('text-5p.pdf'));
  const cta = page.getByRole('button', { name: 'Convert to .docx (Word)' });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await cta.click();
  await page.locator('.result-card').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const p = join(OUT, 'out.docx');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const entries = isZip(b) ? zipEntries(b).map((e) => e.name) : [];
  if (entries.includes('word/document.xml'))
    ok('pdf-to-docx', `docx with ${entries.length} entries`);
  else fail('pdf-to-docx', `zip=${isZip(b)} entries=${entries.join(',')}`);
});
await flow('pdf-to-odt', async (page) => {
  await page.goto(`${BASE}/pdf-to-doc`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('text-5p.pdf'));
  await page.locator('#docfmt').selectOption('odt');
  const cta = page.getByRole('button', { name: 'Convert to .odt (ODF)' });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await cta.click();
  await page.locator('.result-card').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const p = join(OUT, 'out.odt');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const entries = isZip(b) ? zipEntries(b) : [];
  const mt = entries.find((e) => e.name === 'mimetype');
  if (mt && Buffer.from(mt.data).toString('latin1') === 'application/vnd.oasis.opendocument.text')
    ok('pdf-to-odt', `odt with ${entries.length} entries`);
  else fail('pdf-to-odt', `zip=${isZip(b)} entries=${entries.map((e) => e.name).join(',')}`);
});

/* 9. Sign: typed signature + stamp ---------------------------------------- */
await flow('sign typed signature + stamp', async (page) => {
  await page.goto(`${BASE}/pdf-sign`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('text-1p.pdf'));
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.locator('input[placeholder="e.g. Alex Rivera"]').fill('Alex Rivera');
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Use this signature' }).click();
  const stage = page.locator('.stage').first();
  await stage.waitFor({ state: 'visible', timeout: 20000 });
  await stage.click({ position: { x: 120, y: 120 } });
  const cta = page.getByRole('button', { name: /Download signed PDF \(1 stamp\)/ });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  await cta.click();
  const p = join(OUT, 'signed.pdf');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const n = await pageCount(b);
  if (isPdf(b) && n === 1) ok('sign-stamp', 'signed 1-page PDF');
  else fail('sign-stamp', `valid=${isPdf(b)} pages=${n}`);
});

/* 10. Sign: fill form fields ------------------------------------------------ */
await flow('sign fill form fields', async (page) => {
  await page.goto(`${BASE}/pdf-sign`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('form.pdf'));
  const firstField = page.locator('.field input[type="text"]').first();
  await firstField.waitFor({ state: 'visible', timeout: 20000 });
  await firstField.fill('Test value from live check');
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Apply form fill' }).click();
  const cta = page.getByRole('button', { name: 'Download filled PDF' });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  await cta.click();
  const p = join(OUT, 'filled.pdf');
  await (await dl).saveAs(p);
  const b = readFileSync(p);
  const n = await pageCount(b);
  if (isPdf(b) && n === 1) ok('sign-form-fill', 'filled 1-page PDF');
  else fail('sign-form-fill', `valid=${isPdf(b)} pages=${n}`);
});

/* 11. Encrypted PDF → graceful error --------------------------------------- */
await flow('encrypted PDF graceful error', async (page) => {
  await page.goto(`${BASE}/pdf-compress`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').first().setInputFiles(fx('encrypted.pdf'));
  const cta = page.getByRole('button', { name: 'Compress (lossless)' });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  await cta.click();
  const alert = page.locator('[role="alert"]');
  await alert.waitFor({ state: 'visible', timeout: 20000 });
  const text = (await alert.textContent()) || '';
  if (/password|encrypted/i.test(text))
    ok('encrypted-reject', `error: ${text.slice(0, 60).trim()}`);
  else fail('encrypted-reject', `unexpected: ${text.slice(0, 60)}`);
});

/* 12. Redirects from the default host -------------------------------------- */
// The repo is `swd543/pdfboogie` (renamed from `pdf`; GitHub keeps the old
// repo URL 301-ing to the new one). The current GitHub Pages project page
// is swd543.github.io/pdfboogie/ — with the custom domain bound it 301s to
// pdf.bugaboxes.com. The OLD project path swd543.github.io/pdf/ is retired
// by GitHub after a rename (GitHub's stock 404 page — not served from our
// artifact), so a 404 there is expected; a 301 is also acceptable if
// GitHub ever keeps it. Anything else is not.
{
  const current = await fetch('https://swd543.github.io/pdfboogie/', { redirect: 'manual' });
  const currentLoc = current.headers.get('location') || '';
  if (current.status === 301 && currentLoc.startsWith('https://pdf.bugaboxes.com'))
    ok('redirect /pdfboogie/ (current) → custom domain', `${current.status} → ${currentLoc}`);
  else fail('redirect /pdfboogie/ (current) → custom domain', `${current.status} → ${currentLoc}`);

  const old = await fetch('https://swd543.github.io/pdf/', { redirect: 'manual' });
  const oldLoc = old.headers.get('location') || '';
  if (old.status === 404)
    ok(
      'redirect /pdf/ (retired old path)',
      '404 — expected: GitHub retires old project-page paths',
    );
  else if (old.status === 301 && oldLoc.startsWith('https://pdf.bugaboxes.com'))
    ok('redirect /pdf/ (retired old path)', `301 → ${oldLoc} (GitHub still keeps it)`);
  else fail('redirect /pdf/ (retired old path)', `${old.status} → ${oldLoc}`);
}

/* 13. Ad network requests (must be zero — ads inert, no client id) --------- */
if (adRequests.length === 0)
  ok('no ad-network requests', '0 pagead2/doubleclick requests across all flows');
else fail('no ad-network requests', `${adRequests.length}: ${adRequests[0]}`);

await browser.close();

/* summary ----------------------------------------------------------------- */
const passed = results.filter((r) => r.pass).length;
console.log(`\n=== LIVE CHECK: ${passed}/${results.length} passed ===`);
if (pageErrors.length) console.log('uncaught page errors:', pageErrors);
process.exit(passed === results.length && pageErrors.length === 0 ? 0 : 1);
