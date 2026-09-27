/**
 * Post-build finalisation for the static output.
 *
 *  1. Copies Nitro's static output (`.output/public`) into `dist/`
 *     (GH Pages artifacts + local preview both expect `dist/`).
 *  2. Writes `dist/sitemap.xml` from the known route list.
 *  3. Writes `dist/robots.txt` with the absolute sitemap URL.
 *  4. Emits a branded `dist/404.html` fallback for unknown URLs.
 *  5. Prints a short size report.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outPub = join(root, '.output', 'public');
const dist = join(root, 'dist');

const siteUrl = (process.env.VITE_SITE_URL || 'https://example.com').replace(/\/$/, '');

/* ---------------------------------------------------------------- */
/* 1. copy static output → dist                                      */
/* ---------------------------------------------------------------- */
if (!existsSync(outPub)) {
  console.error('[postbuild] .output/public not found — did the nitro static build run?');
  process.exit(1);
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(outPub, dist, { recursive: true });
console.log('[postbuild] copied .output/public → dist');

/* ---------------------------------------------------------------- */
/* 2. sitemap.xml                                                    */
/* ---------------------------------------------------------------- */
const routes = [
  '/',
  '/pdf-compress/',
  '/pdf-merge/',
  '/pdf-combine/',
  '/image-to-pdf/',
  '/pdf-to-image/',
  '/pdf-to-doc/',
  '/pdf-sign/',
  '/privacy/',
];
const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (r) => `  <url>
    <loc>${r === '/' ? `${siteUrl}/` : `${siteUrl}${r}`}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
  </url>`,
  )
  .join('\n')}
</urlset>
`;
writeFileSync(join(dist, 'sitemap.xml'), sitemap);
console.log('[postbuild] wrote dist/sitemap.xml');

/* ---------------------------------------------------------------- */
/* 3. robots.txt                                                     */
/* ---------------------------------------------------------------- */
const robots = `User-agent: *
Allow: /

Sitemap: ${siteUrl}/sitemap.xml
`;
writeFileSync(join(dist, 'robots.txt'), robots);
console.log('[postbuild] wrote dist/robots.txt');

/* ---------------------------------------------------------------- */
/* 4. 404.html fallback (GH Pages serves this for unknown URLs)      */
/* ---------------------------------------------------------------- */
const notFound = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Page not found — PDFBoogie</title>
<meta name="robots" content="noindex" />
<meta name="referrer" content="no-referrer" />
<link rel="icon" href="favicon.svg" type="image/svg+xml" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background: #faf9f6; color: #1a1a1e; margin: 0; display: grid; place-items: center; min-height: 100dvh; }
  @media (prefers-color-scheme: dark) { body { background: #101114; color: #ededea; } }
  main { text-align: center; padding: 2rem; max-width: 26rem; }
  h1 { font-size: 2rem; margin: 0 0 0.75rem; }
  p { opacity: 0.7; }
  a.btn { display: inline-block; margin-top: 1rem; background: #c8451f; color: #fff; text-decoration: none; padding: 0.6rem 1.2rem; border-radius: 8px; font-weight: 600; }
</style>
</head>
<body>
  <main>
    <h1>404 — page not found</h1>
    <p>The page you're looking for doesn't exist. The PDF tools are one click away.</p>
    <a class="btn" href="./">Back to the tools</a>
  </main>
</body>
</html>
`;
writeFileSync(join(dist, '404.html'), notFound);
console.log('[postbuild] wrote dist/404.html');

/* ---------------------------------------------------------------- */
/* 5. size report                                                    */
/* ---------------------------------------------------------------- */
let total = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else total += statSync(p).size;
  }
}
walk(dist);
console.log(
  `[postbuild] dist total: ${(total / 1024 / 1024).toFixed(2)} MB (${readdirSync(dist).length} top-level entries)`,
);
