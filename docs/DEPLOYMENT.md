# Deployment

Target: **GitHub Pages** (repo `swd543/pdfboogie` → live at
`https://pdf.bugaboxes.com/`, with `https://swd543.github.io/pdfboogie/`
301-redirecting there), deployed by GitHub Actions — no
manual artifact uploading.

## One workflow: `.github/workflows/ci.yml`

| Job | When | What it does |
|---|---|---|
| `wasm` | every push + PR | Rust toolchain + prebuilt `wasm-pack` → `wasm-pack build --target web` → uploads `wasm/pdfcore/pkg` as the `pdfcore-pkg` artifact |
| `test` | every push + PR | downloads `pdfcore-pkg` → pnpm 11.13.1 + Node 24 → `typecheck` → `lint` (biome) → unit tests → build with `VITE_BASE=/` → `playwright install --with-deps chromium` → E2E suite against the production `dist` (served on `:8899`) |
| `deploy` | pushes to `main` | downloads `pdfcore-pkg` → build with `VITE_BASE=/` + `VITE_SITE_URL=https://pdf.bugaboxes.com` → `upload-pages-artifact@v3` → `deploy-pages@v4` |

One base path for both: the custom domain `pdf.bugaboxes.com` is bound to
the site's **root** by GitHub, so the live site and the E2E harness (the
Playwright `baseURL`) both serve it from `/`. The GitHub Pages project-page
URL `swd543.github.io/pdfboogie/…` 301-redirects to `pdf.bugaboxes.com/…`
(GitHub's custom-domain behavior — the prefix is dropped), which is also why
the canonical/SEO URLs are the `pdf.bugaboxes.com` ones. After the repo was
renamed `pdf` → `pdfboogie`, the *old* project-page path
`swd543.github.io/pdf/…` is retired by GitHub — it serves GitHub's stock 404
page (not our site), so any deep links to it should be rewritten to the
custom domain. The old repo URL `github.com/swd543/pdf` still 301s to
`github.com/swd543/pdfboogie` (GitHub keeps old repo names). The live check
asserts the current `/pdfboogie/` 301 and treats the retired `/pdf/` path as
404 (expected) or 301 (if GitHub ever keeps it). If the custom domain is
ever removed, the site would need `VITE_BASE=/pdfboogie/` to work directly
under `swd543.github.io/pdfboogie/`.

## Manual steps (once per repo)

1. **Settings → Pages → Build and deployment → Source: `GitHub Actions`**.
   (Required; otherwise Pages won't pick up the deploy artifact.)
2. Push to `main` — the first run of `test` + `deploy` provisions the Pages
   site. Watch the `deploy` job; its `url` output is the live site.
3. Unknown URLs serve the generated `dist/404.html` (GitHub Pages' custom
   404 behavior) — no SPA fallback configuration needed, since routing is
   prerendered static files.

## Environment variables (build-time)

| Var | Default | Purpose |
|---|---|---|
| `VITE_BASE` | `/` | Asset/base path. The Pages deploy uses `/` (custom domain bound to site root — see above); `/pdfboogie/` is the fallback without the domain. |
| `VITE_SITE_URL` | `http://localhost:3000` | Absolute URL used in sitemap, robots and OG tags. |
| `VITE_ADSENSE_CLIENT` | *(unset → ads inert)* | AdSense client id, e.g. `ca-pub-…`. See [ADS](ADS.md). |

## Running locally against the production build

```sh
pnpm build && node scripts/postbuild.mjs
python3 -m http.server 8899 --directory dist   # what the E2E suite uses
```

`pnpm start` (vite preview) also works but the E2E suite pins the plain
static server so what is tested is exactly what gets deployed.

## Updating the WASM core

The Rust crate lives in `wasm/pdfcore/`. `wasm/pdfcore/pkg/` is a build
artifact (gitignored) — **nothing is committed**; CI compiles it in the
`wasm` job and both builds download the `pdfcore-pkg` artifact. To rebuild
locally: install `rustup` + `wasm-pack`, then `pnpm wasm` (writes
`wasm/pdfcore/pkg/`, which `scripts/copy-assets.mjs` copies into
`public/wasm/`). No git step is needed — just push the source changes.

## Notes

- The E2E suite needs the `dist/` build to exist (checked in
  `e2e/global-setup.ts`) and regenerates PDF fixtures when missing
  (the encrypted fixture needs Ghostscript: `apt-get install ghostscript`).
- There is no runtime environment config: the site is static. The only
  runtime difference ever is the AdSense client id, baked in at build time.
