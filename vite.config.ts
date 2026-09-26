/**
 * Vite + SolidStart v2 + Nitro (static preset).
 *
 * - `solidStart()` wires file-system routing, SSR and the client entry.
 * - `nitro()` with the `static` preset produces a pure static site in
 *   `.output/public` during `vite build` — that is what gets deployed to
 *   GitHub Pages (see docs/DEPLOYMENT.md).
 *
 * `base` supports hosting on a GitHub *project* page:
 *   VITE_BASE=/ pnpm build   (Pages deploy: base / — the custom domain pdf.bugaboxes.com is bound to the site root; see .github/workflows/ci.yml)
 */
import { randomBytes } from 'node:crypto';
import { solidStart } from '@solidjs/start/config';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

const base = process.env.VITE_BASE ?? '/';

// Static, per-build CSP nonce. The document template allows
// `script-src 'self' 'nonce-…'` for the framework's inline hydration
// bootstrap; every inline script solid-start emits is stamped with this
// nonce (see entry-server.tsx). For a fully static site a build-time nonce
// is the correct granularity — there is no per-request SSR to rotate it.
const ssrNonce = randomBytes(16).toString('base64');

export default defineConfig({
  base,
  plugins: [solidStart(), nitro()],
  nitro: {
    preset: 'static',
    prerender: {
      // Entry point for the crawler; every tool page is linked from here
      // (header nav + footer + home grid) so crawlLinks covers them all.
      routes: ['/'],
      crawlLinks: true,
      failOnError: true,
    },
  },
  build: {
    // pdf.js v6 and our code both target modern evergreen browsers.
    target: 'es2022',
  },
  define: {
    'import.meta.env.SSR_NONCE': JSON.stringify(ssrNonce),
  },
  logLevel: 'info',
});
