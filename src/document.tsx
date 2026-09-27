/**
 * HTML document template for SolidStart v2.
 *
 * Rendered on the server (prerendering + any SSR) and as the shell the
 * client hydrates into. All SEO-critical base metadata lives here; per-route
 * titles/descriptions are injected via @solidjs/meta inside each route.
 */

import type { DocumentComponentProps } from '@solidjs/start/server';
import { site } from '~/site/config';

/**
 * Content-Security-Policy applied via <meta> (works on any static host,
 * unlike header-based CSP).
 *
 * - With ads disabled the policy only allows same-origin resources.
 * - With ads enabled the AdSense domains are added (script + connect + frames).
 *
 * Inline scripts: solid-start emits a small inline hydration bootstrap and
 * per-route task scripts. Those are stamped with a build-time CSP nonce
 * (`import.meta.env.SSR_NONCE`, see vite.config.ts + entry-server.tsx) and
 * allowed via `script-src 'self' 'nonce-…'`. No other inline script is
 * permitted; workers and objects stay same-origin / disabled.
 */
function contentSecurityPolicy(): string {
  const nonce = import.meta.env.SSR_NONCE ? `'nonce-${import.meta.env.SSR_NONCE}'` : '';
  const adsense = site.adsenseClient !== '';
  // One entry per directive — CSP applies the *first* directive of a given
  // name, so these must never be duplicated.
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      // WebAssembly compilation (the Rust pdfcore module is compiled in the
      // page, buffer-based) requires this CSP keyword; it allows WASM only
      // and does not re-enable JS eval. Browsers without it keep the site
      // working via the pure-JS fallback pipeline.
      "'wasm-unsafe-eval'",
      ...(nonce ? [nonce] : []),
      // AdSense serves external classic scripts (no nonce) — allow its
      // script hosts for scripts only.
      ...(adsense ? ['https://pagead2.googlesyndication.com', 'https://*.google.com'] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'connect-src': [
      "'self'",
      ...(adsense
        ? ['https://*.google.com', 'https://*.doubleclick.net', 'https://*.googlesyndication.com']
        : []),
    ],
    'font-src': ["'self'", 'data:'],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    // note: frame-ancestors is intentionally absent — it is ignored when CSP
    // is delivered via <meta> (browser console warning), and the site is static.
    ...(adsense ? { 'frame-src': ['https://*.google.com', 'https://*.doubleclick.net'] } : {}),
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

export function Document(props: DocumentComponentProps) {
  const base = import.meta.env.BASE_URL;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta http-equiv="content-security-policy" content={contentSecurityPolicy()} />
        <meta name="description" content={site.description} />
        <meta property="og:site_name" content={site.name} />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary" />
        <link rel="icon" href={`${base}favicon.svg`} type="image/svg+xml" />
        <link rel="manifest" href={`${base}manifest.webmanifest`} />
        <meta name="theme-color" content="#c8451f" />
        {props.assets}
      </head>
      <body>
        <a href="#main" class="skip-link">
          Skip to content
        </a>
        <div id="app">{props.children}</div>
        {props.scripts}
      </body>
    </html>
  );
}
