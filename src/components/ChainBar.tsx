/**
 * Tool chaining UI.
 *
 * - `pdfChainLinks(path)` — which tools can consume a PDF output, per
 *   current page (no self-links).
 * - `ChainSection` — the page-footer section: shows the static "Related"
 *   links, and after an operation completes it transitions into
 *   "Continue with {file}" with the chain links (cheap CSS entry
 *   animation on the switch).
 * - `ChainNote` — "added from your previous step" note on the consuming
 *   tool (dismissible; the file itself stays loaded).
 *
 * The file itself travels in memory only (see `~/lib/chain`) — nothing
 * is uploaded or persisted.
 */
import { useLocation, useNavigate } from '@solidjs/router';
import { Show } from 'solid-js';
import { CloseIcon } from '~/components/Icons';
import { setChainedFile } from '~/lib/chain';

interface ToolLink {
  path: string;
  label: string;
}

/** Which tools can consume a PDF output, per current path (no self-links). */
const PDF_LINKS: Record<string, ToolLink[]> = {
  '/pdf-compress': [
    { path: '/pdf-merge', label: 'Merge' },
    { path: '/pdf-combine', label: 'Combine pages' },
    { path: '/pdf-to-image', label: 'PDF → Image' },
    { path: '/pdf-to-doc', label: 'PDF → Word' },
    { path: '/pdf-sign', label: 'Sign & Fill' },
  ],
  '/pdf-merge': [
    { path: '/pdf-compress', label: 'Compress' },
    { path: '/pdf-combine', label: 'Combine pages' },
    { path: '/pdf-to-image', label: 'PDF → Image' },
    { path: '/pdf-to-doc', label: 'PDF → Word' },
    { path: '/pdf-sign', label: 'Sign & Fill' },
  ],
  '/pdf-combine': [
    { path: '/pdf-compress', label: 'Compress' },
    { path: '/pdf-merge', label: 'Merge' },
    { path: '/pdf-to-image', label: 'PDF → Image' },
    { path: '/pdf-to-doc', label: 'PDF → Word' },
    { path: '/pdf-sign', label: 'Sign & Fill' },
  ],
  '/image-to-pdf': [
    { path: '/pdf-compress', label: 'Compress' },
    { path: '/pdf-merge', label: 'Merge' },
    { path: '/pdf-combine', label: 'Combine pages' },
    { path: '/pdf-to-image', label: 'PDF → Image' },
    { path: '/pdf-to-doc', label: 'PDF → Word' },
    { path: '/pdf-sign', label: 'Sign & Fill' },
  ],
  '/pdf-sign': [
    { path: '/pdf-compress', label: 'Compress' },
    { path: '/pdf-merge', label: 'Merge' },
    { path: '/pdf-combine', label: 'Combine pages' },
    { path: '/pdf-to-image', label: 'PDF → Image' },
    { path: '/pdf-to-doc', label: 'PDF → Word' },
  ],
};

/** Chain links for the current path (normalized; [] when none apply). */
export function pdfChainLinks(pathname: string): ToolLink[] {
  return PDF_LINKS[pathname.replace(/\/$/, '')] ?? [];
}

/**
 * Footer section that is "Related: …" until an operation completes, then
 * transitions into "Continue with {file}: …" (the chain links). The
 * keyed <Show> remounts the content on the switch, re-running the cheap
 * CSS entry animation.
 */
export function ChainSection(props: {
  related: { path: string; label: string }[];
  /** Returns the finished result (bytes + name) or null. */
  result: () => { bytes: Uint8Array; name: string } | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const r = () => props.result();
  const hasChain = () => r() !== null && pdfChainLinks(location.pathname).length > 0;

  return (
    <Show when={hasChain() || props.related.length > 0}>
      <div class="related" classList={{ 'has-chain': hasChain() }}>
        <Show when={hasChain()} keyed>
          {(isChain) =>
            isChain ? (
              <Show when={r()}>
                {(res) => (
                  <>
                    <span class="related-label">
                      Continue with <strong>{res().name}</strong>:
                    </span>
                    {pdfChainLinks(location.pathname).map((l) => (
                      <button
                        type="button"
                        class="chain-link"
                        aria-label={`Open ${l.label} with ${res().name}`}
                        onClick={() => {
                          const v = r();
                          if (!v) return;
                          const blob = new Blob([v.bytes as BlobPart], {
                            type: 'application/pdf',
                          });
                          setChainedFile({
                            blob,
                            name: v.name,
                            type: 'application/pdf',
                            size: blob.size,
                          });
                          navigate(l.path);
                        }}
                      >
                        {l.label}
                      </button>
                    ))}
                  </>
                )}
              </Show>
            ) : (
              <>
                <span class="related-label">Related:</span>
                {props.related.map((x) => (
                  <a href={x.path}>{x.label}</a>
                ))}
              </>
            )
          }
        </Show>
      </div>
    </Show>
  );
}

/**
 * "Added from your previous step" note shown on the tool that consumed a
 * chained file (dismissible; the file itself stays loaded).
 *
 * Solid note: visibility must be a JSX-level <Show> — a top-level
 * `if (!note()) return null` would only evaluate once.
 */
export function ChainNote({ note, dismiss }: { note: () => string; dismiss: () => void }) {
  return (
    <Show when={note()}>
      <div class="chain-note" role="status">
        <span>
          <strong>{note()}</strong> — added from your previous step.
        </span>
        <button type="button" onClick={dismiss} aria-label="Dismiss note">
          <CloseIcon />
        </button>
      </div>
    </Show>
  );
}
