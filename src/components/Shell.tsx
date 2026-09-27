/**
 * Shared UI components.
 */

import { useLocation } from '@solidjs/router';
import { createSignal, type JSX } from 'solid-js';
import { site, staticPages, tools } from '~/site/config';
import { ChainSection } from './ChainBar';
import { Logo, UploadIcon } from './Icons';

/** Page chrome: sticky header with tool nav, main container, footer. */
export function Shell(props: { children?: JSX.Element }) {
  const location = useLocation();
  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  const [copiedId, setCopiedId] = createSignal<string | null>(null);
  const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`;
  const copyAddress = async (id: string, address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — the address is visible anyway */
    }
  };

  return (
    <div class="site">
      <header class="site-header">
        <div class="container">
          <a href="/" class="logo" aria-label={`${site.name} home`}>
            <Logo />
            <span>{site.name}</span>
          </a>
          <nav class="site-nav" aria-label="PDF tools">
            {tools.map((t) => (
              <a href={t.path} aria-current={isActive(t.path) ? 'page' : undefined}>
                {t.label}
              </a>
            ))}
            {staticPages.map((p) => (
              <a href={p.path} aria-current={isActive(p.path) ? 'page' : undefined}>
                {p.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main id="main" class="site-main">
        <div class="container">{props.children}</div>
      </main>

      <footer class="site-footer">
        <div class="container">
          <span>
            © {new Date().getFullYear()} {site.name} · processed locally, always private.
          </span>
          <nav aria-label="Footer">
            {tools.map((t) => (
              <a href={t.path}>{t.label}</a>
            ))}
            <a href="/privacy">Privacy</a>
          </nav>
          <div class="donate">
            <span class="donate-label">
              Free to use, but hosting isn't free. If PDFBoogie helps, a donation is appreciated:
            </span>
            {site.donation.map((d) => (
              <span class="donate-addr" title={d.address}>
                {d.scheme ? (
                  <a href={`${d.scheme}:${d.address}`}>
                    {d.label} {shortAddr(d.address)}
                  </a>
                ) : (
                  <span class="donate-plain">
                    {d.label} {shortAddr(d.address)}
                  </span>
                )}
                {d.memo ? <em class="donate-memo">memo {d.memo}</em> : null}
                <button
                  type="button"
                  class="donate-copy"
                  onClick={() => copyAddress(d.id, d.address)}
                  aria-label={`Copy ${d.label} address`}
                >
                  {copiedId() === d.id ? 'Copied ✓' : 'Copy'}
                </button>
              </span>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * Tool page scaffold: SEO intro + badges, children, related links (which
 * transition into the "Continue with" chain after an operation), and the
 * persistent bottom ad slot (inactive until AdSense is configured).
 */
export function ToolPage(props: {
  title: string;
  lede: string;
  related?: { path: string; label: string }[];
  /** Finished result (PDF tools) — switches the footer to chain mode. */
  chainResult?: () => { bytes: Uint8Array; name: string } | null;
  children: JSX.Element;
}) {
  return (
    <div class="tool-page">
      <div class="tool-intro">
        <h1>{props.title}</h1>
        <p class="lede">{props.lede}</p>
        <div class="badge-row">
          <span class="badge">
            <ShieldTiny /> 100% private: runs in your browser
          </span>
          <span class="badge">
            <BoltTiny /> No upload · No account
          </span>
        </div>
      </div>
      {props.children}
      <ChainSection related={props.related ?? []} result={props.chainResult ?? (() => null)} />
    </div>
  );
}

function ShieldTiny() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
    </svg>
  );
}

function BoltTiny() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

/** Two-column tool layout: main interaction area + options aside. */
export function ToolColumns(props: { aside: JSX.Element; children: JSX.Element }) {
  return (
    <div class="tool-grid-cols">
      <div class="tool-main">{props.children}</div>
      <aside class="tool-aside">{props.aside}</aside>
    </div>
  );
}

/** Progress bar with label + percent. */
export function ProgressBar(props: { done: number; total: number; label?: string }) {
  const pct = () =>
    props.total > 0 ? Math.min(100, Math.round((props.done / props.total) * 100)) : 0;
  return (
    <div class="progress" role="status" aria-live="polite">
      <div class="progress-label">
        <span>{props.label ?? 'Working…'}</span>
        <span>{pct()}%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style={{ width: `${pct()}%` }} />
      </div>
    </div>
  );
}

/**
 * File drop zone with keyboard support and a hidden <input type="file">.
 * Emits the dropped/selected files to `onFiles`; validation is the caller's
 * job (different per tool).
 *
 * Mobile note: the picker is opened by tapping the *native* file input
 * itself — it is rendered as a full-size, transparent overlay (`.dz-input`)
 * so the tap lands on a real form control and the OS file intent fires
 * reliably. A programmatic `input.click()` from a synthetic tap handler is
 * not trustworthy on iOS/Android.
 */
export function DropZone(props: {
  accept: string;
  multiple?: boolean;
  title: string;
  subtitle: string;
  busy?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const [dragging, setDragging] = createSignal(false);

  const handleFiles = (list: FileList | null) => {
    if (!list || props.disabled) return;
    const files = Array.from(list);
    if (files.length > 0) props.onFiles(files);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target; interactive control is the file <input> inside
    <div
      class="dropzone"
      data-dragging={dragging()}
      data-busy={props.busy ? 'true' : 'false'}
      onDragOver={(e) => {
        e.preventDefault();
        if (!props.disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer?.files ?? null);
      }}
    >
      <div class="dz-visual" aria-hidden="true">
        <UploadIcon class="dz-icon" />
        <div class="dz-title">{props.title}</div>
        <div class="dz-sub">
          <span class="dz-browse">Browse</span> or drag &amp; drop: {props.subtitle}
        </div>
      </div>
      <input
        class="dz-input"
        type="file"
        accept={props.accept}
        multiple={props.multiple}
        aria-label={props.title}
        disabled={props.disabled}
        onChange={(e) => {
          handleFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}
