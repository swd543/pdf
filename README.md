# PDFBoogie

[![CI & Deploy](https://github.com/swd543/pdfboogie/actions/workflows/ci.yml/badge.svg)](https://github.com/swd543/pdfboogie/actions/workflows/ci.yml)

Private PDF tools for the browser. Every operation (compressing, merging,
converting, signing) runs entirely on your machine. Your documents are never
uploaded anywhere: there is no backend to upload to.

**Live at [pdf.bugaboxes.com](https://pdf.bugaboxes.com).**

- **Compress PDF**: lossless re-save (custom Rust/WASM core) or a strong
  visual-quality mode that rebuilds pages as optimized images. A sensible
  mode is auto-picked per document (image-heavy → strong, text/vector →
  lossless) and page previews are rendered before you commit.
- **Merge PDF**: combine PDFs (and images) into one document. Every page is
  rendered as a thumbnail in a reorderable strip. Drag the grip (mouse or
  touch) or use the arrows to arrange pages individually, tap to select,
  Ctrl/⌘+tap to add, Shift+tap for a range, and move whole files up and
  down. Image pages preview exactly as they will be placed: page size and
  margins update the previews live.
- **Combine pages (n-up)**: place 2 / 4 / 6 / 9 pages per sheet, portrait or
  landscape, like a home-print 2-up layout, with page previews and a live
  preview of the combined sheets that re-renders whenever the layout changes.
- **Image → PDF**: turn PNG/JPEG/WebP images into a PDF, one image per page.
- **PDF → Image**: export pages as PNG, JPEG or WebP (any DPI), single file or
  ZIP.
- **Sign & Fill**: draw, type or upload a signature, place stamps on any page,
  and fill standard PDF form fields (text, checkbox, dropdown).

Nothing downloads on its own: every result waits behind an explicit Download
button, and the footer's “Related” links transition into “Continue with {file}”
after an operation, chaining the result into any other tool with one click
(in-memory only; the file never leaves the browser).

Built with [SolidStart](https://start.solidjs.com) (SSG), pdf.js, pdf-lib,
fflate and a hand-rolled Rust/WASM core. No server-side code: the whole site is
static HTML + JS.

## Quick start

```sh
pnpm install
pnpm dev          # http://localhost:3000 (assets copied automatically)
```

Other scripts:

```sh
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check .
pnpm test         # unit tests (vitest)
pnpm build        # production build (base path via VITE_BASE, default /)
pnpm start        # serve the built site

pnpm test:fixtures   # regenerate the E2E PDF/image fixtures
pnpm test:e2e        # Playwright E2E against the production build
pnpm wasm            # rebuild the Rust/WASM core (needs wasm-pack)
pnpm og              # regenerate the Open Graph image
```

## Privacy model

All processing happens in the browser:

- PDF parsing/rendering: **pdf.js** (lazy-loaded, WASM-free worker).
- Structural edits (merge, form fill, stamps, encryption checks): **pdf-lib**.
- Lossless re-save + file probing: **pdfcore** (Rust + lopdf compiled to
  WebAssembly, ~364 KB, with a pure-JS fallback).
- ZIP creation (PDF → Image, multi-file outputs): **fflate** in JS.

No analytics, no telemetry, no cookies. See `src/site/config.ts` for the
donation wallet info shown in the footer (direct wallet addresses, no
intermediary).

## Layout

```
src/
  app.tsx            routes + shell
  document.tsx       <html> template, CSP, meta
  entry-client.tsx   browser entry (hydration)
  entry-server.tsx   SSG entry
  site/              config (brand, tools, wallets), seo, ads
  components/        Shell, DropZone, AdSlot, SignaturePad, Icons, ...
  lib/               pdfjs wrapper, pdf-lib wrapper, wasm, zip, imaging, ...
  features/          one folder per tool: pure logic + unit tests
  routes/            one file per public URL (SSG prerenders each)
wasm/pdfcore/        Rust crate (lopdf) → wasm/pdfcore/pkg/ (CI-built) → public/wasm/
e2e/                 Playwright suite, fixtures generator, helpers
scripts/             asset copy, sitemap/robots postbuild, og-image
docs/                architecture, ads, seo, deployment
```

Each tool is a route with its own lazy-loaded chunk; page bundles stay small
and the landing page prerenders to fully static HTML for search engines.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): framework, PDF stack, WASM core.
- [Ads](docs/ADS.md): how the (optional) AdSense slots stay non-intrusive.
- [SEO](docs/SEO.md): prerendering, meta, JSON-LD, sitemap.
- [Deployment](docs/DEPLOYMENT.md): GitHub Pages via Actions.

## License

MIT. See `LICENSE` (or your preferred terms; adjust before publishing).
