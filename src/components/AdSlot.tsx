/**
 * AdSlot — the single integration point for Google AdSense.
 *
 * Behaviour (non-intrusive by design):
 *  - No publisher id configured (`VITE_ADSENSE_CLIENT` empty): the slot is
 *    hidden until the visitor's first operation; after that it shows a
 *    pixel-art "thank you" banner (public/thank-you.gif, AdSense-leaderboard
 *    proportions) — the same timing and footprint the ad will have. Local
 *    asset only, no external requests. In dev, a subtle chip marks the slot
 *    so the layout is visible.
 *  - Publisher id set: the slot stays COLLAPSED (no script, no request,
 *    zero height) until the visitor's first operation starts. `expandAds()`
 *    (src/site/ads.ts) is called by the tools when processing begins —
 *    from that moment on every slot expands and stays expanded for the
 *    rest of the page life (the ad persists after the operation finishes).
 *  - The AdSense script is loaded lazily, only once, and only after the
 *    first expansion — a visitor who never runs a tool sends no ad requests.
 *
 * Placement strategy lives in docs/ADS.md. Slots: `processing` (inside the
 * processing panel — visible while work runs), `tool-bottom`, `home-bottom`.
 */
import { createEffect, on } from 'solid-js';
import { adsExpanded } from '~/site/ads';
import { site } from '~/site/config';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

let scriptPromise: Promise<void> | null = null;

/** Inject the AdSense loader script exactly once. */
function ensureAdScript(): Promise<void> {
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${site.adsenseClient}`;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve();
      script.onerror = () => resolve(); // ads blocked → keep the site functional
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

export function AdSlot(props: { slot?: string; className?: string }) {
  const enabled = site.adsenseClient !== '';
  // Collapsed until the first operation starts; persists once expanded.
  const visible = () => adsExpanded();
  // Pre-AdSense placeholder: the pixel-art thank-you appears exactly where
  // the ad will appear (after the first operation). AdSense set → real ad.
  const showThanks = () => !enabled && visible() && !import.meta.env.DEV;
  let pushed = false;

  // Load the ad only after expansion — never before the visitor acts.
  createEffect(
    on(visible, (show) => {
      if (!show || !enabled || pushed) return;
      pushed = true;
      void (async () => {
        await ensureAdScript();
        try {
          const list = window.adsbygoogle ?? [];
          window.adsbygoogle = list;
          list.push({});
        } catch {
          /* ad blocked or script failed — nothing to do */
        }
      })();
    }),
  );

  // Dev only: keep the layout footprint visible even before expansion.
  return (
    <div
      class={`ad-slot ${props.className ?? ''}`}
      data-ad-slot={props.slot ?? ''}
      data-expanded={visible() ? 'true' : 'false'}
    >
      {enabled && visible() ? (
        <ins class="adsbygoogle" style="display: block" />
      ) : showThanks() ? (
        <img
          class="ad-thanks"
          src={`${import.meta.env.BASE_URL}thank-you.gif`}
          alt="Thank you for using PDFBoogie"
          width="720"
          height="90"
          loading="lazy"
          draggable={false}
        />
      ) : import.meta.env.DEV ? (
        <span class="ad-dev">ad slot · {props.slot ?? 'default'}</span>
      ) : null}
    </div>
  );
}
