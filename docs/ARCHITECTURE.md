# Architecture

PDFBoogie is a static site: no server code, no build-time or runtime
dependency on a backend. The only "server" is a static file host.

## Framework: SolidStart (SSG mode)

- `solidStart()` + Nitro `preset: 'static'`: every route is prerendered to
  plain HTML at build time (`prerender: { crawlLinks: true }`), so search
  engines see full content and the site works with JS disabled for reading.
- File-based routing under `src/routes/` — one file per public URL. Each
  tool route is code-split: its chunk (and the pdf.js / pdf-lib libraries
  it uses) loads only when you open that tool.
- `@solidjs/meta` drives per-route `<title>`/`<meta>`; JSON-LD is injected
  per route (see [SEO](SEO.md)).

### Two non-obvious framework quirks (patched)

1. **Lazy routes under SSG.** `renderToString` never resolves `lazy()`
   components; `renderToStream` resolves them only inside `<Suspense>`.
   SolidStart v2's router renders route outlets without a Suspense boundary,
   so SSR hung forever. Fix: a `pnpm patch` on `@solidjs/router` that wraps
   the route `outlet` in `<Suspense>` (see `patches/`, applied via
   `pnpmfile`/patchedDependencies in `package.json`).
2. **CSP nonce for static builds.** `document.tsx` emits a strict CSP with
   `script-src 'self' 'nonce-…'`. The nonce is a fixed build-time constant
   (injected from `vite.config.ts` → `entry-server.tsx` → `document.tsx`
   via `import.meta.env.SSR_NONCE`), so prerendered HTML and the hashed
   module scripts agree without a per-request server. `frame-ancestors` is
   deliberately **not** in the meta CSP (it is ignored by browsers in
   `<meta>`; shipping it only produces a console warning).

## PDF stack

| Concern | Library | Notes |
|---|---|---|
| Parse/render | **pdf.js 6.x** (lazy) | worker via `pdf.worker.min.mjs?url` + `workerPort`; cMaps + standard fonts are copied to `public/` and fetched only when a document actually needs them. |
| Structural edits | **pdf-lib** (lazy) | merge page-copy, form fill + appearance regeneration, signature stamps, encryption detection. |
| Lossless re-save / probe | **pdfcore** (Rust/WASM) | lopdf-based; the fastest, most compatible "re-save" path for compression, with a pure-JS fallback if WASM fails to load. |
| ZIP | **fflate** | multi-page image export (PDF → Image) and anything else that needs a ZIP, all in JS. |
| Pixels | native `createImageBitmap` / `OffscreenCanvas` | no canvas-to-blob polyfills. |

### pdf.js gotchas that shaped the code

- `getDocument({ data })` **takes ownership of the ArrayBuffer** (it
  transfers it to the worker, detaching the original). Any code that needs
  the bytes afterwards must pass a copy. `src/lib/pdfjs.ts` also serializes
  `loadingTask.destroy()` behind a module-level chain: a new `getDocument`
  that races an in-flight destroy fails with "the worker is being
  destroyed", so every open awaits the last destroy first.
- v6 `render()` needs `{ canvas, viewport }` and the task must be
  `destroy()`ed (see `disposePdf`).
- In Node (tests/E2E validation) pdfjs wants a plain `Uint8Array` and
  refuses Node `Buffer`s — the E2E helpers convert before `getDocument`.
  And `pdfjs.getDocument` **detaches the buffer it is given** (it transfers
  it to the worker), so any validator that needs the bytes afterwards must
  hand pdfjs a copy (`e2e/helpers.ts` does this in `pdfInfo`).
- pdfjs 6 computes a document fingerprint during every `getDocument()` via
  `Uint8Array.prototype.toHex()` — a Baseline-2025 API (Chrome 140+,
  Firefox 133+, Safari 18.2+, Node 26+). On older engines every document
  load throws `toHex is not a function`. A ~10-line polyfill is installed
  before pdfjs loads, both in the site (`src/lib/pdfjs.ts`, for older
  WebViews) and in the E2E Node validators (`e2e/helpers.ts`, so the suite
  runs on any Node — CI uses Node 24).

## Rust/WASM core (`wasm/pdfcore`)

- `lopdf` 0.37, compiled with `wasm-pack --target web` →
  `wasm/pdfcore/pkg/` (~364 KB `.wasm` + JS glue).
- API (via `src/lib/wasm.ts`): `init()`, `lossless_compress(bytes)`,
  `probe(bytes) → { pages, encrypted, … }`.
- **No build artifacts are committed.** `wasm/pdfcore/pkg/` is a build
  output (gitignored). CI builds it in a dedicated `wasm` job (Rust
  toolchain + prebuilt `wasm-pack` binary → `pdfcore-pkg` artifact), and
  the `test`/`deploy` jobs download it before `pnpm build`. Locally,
  `pnpm wasm` builds it (needs `rustup` + `wasm-pack` on PATH; do **not**
  use the distro rust). `scripts/copy-assets.mjs` (run on predev/prebuild)
  then copies `pkg/` → `public/wasm/` along with pdf.js cMaps and standard
  fonts. If WASM fails to load in the browser, the app transparently falls
  back to a pure-JS re-save.

## Features are pure modules

Every tool's logic lives in `src/features/<tool>/logic.ts` as plain async
functions over `Uint8Array` inputs, with a co-located
`logic.test.ts` (vitest, incl. integration tests that run the real WASM
core and pdf-lib). Routes are thin: file state, progress, error handling,
DOM. This keeps the interesting code testable in Node without a browser.

## Tool chaining (explicit downloads, no auto-download)

Tools never auto-download: results wait behind a Download button. The
footer “Related” section (`ChainSection` in `src/components/ChainBar.tsx`)
transitions into “Continue with {file}” once a result exists; clicking a
link stores the result in `src/lib/chain.ts` (module-level, in-memory only)
and navigates. The target route pulls it up in `onMount` via
`useChainedPdf(consume)` and prefills its normal file-add path, showing a
dismisseable “added from your previous step” note. One-shot: the first
tool that mounts consumes and clears it.

Two non-obvious pitfalls baked into the implementation:

- Solid evaluates a component's function body **once** — a top-level
  `if (!note()) return null` never re-runs when the signal changes.
  Visibility must be JSX-level (`<Show>`), not a conditional return.
- SolidStart 301s `/tool` → `/tool/`; match `location.pathname` against
  tables only after stripping the trailing slash.

## Mobile-first details

- The DropZone's file picker is a real `<input type="file">` stretched over
  the whole zone (transparent, last in DOM) so a tap opens the OS file
  picker — programmatic `.click()` on hidden inputs is unreliable on
  mobile.
- Responsive: no horizontal overflow at 360/768/1280 (guarded by E2E).
  The classic flex `min-width: auto` trap is handled on the header nav
  (scrolls) and footer (wraps).
