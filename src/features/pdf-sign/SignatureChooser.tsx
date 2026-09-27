/**
 * Signature chooser panel for Sign & Fill (handoff P2.3).
 *
 * Presentational: the draw/type/upload tabs, the signature preview and
 * the place/discard controls. All actions are callbacks into the route,
 * which owns the signature bytes, stamps and download state.
 */
import { Show } from 'solid-js';
import { DropZone } from '~/components/Shell';
import type { SignaturePadApi } from '~/components/SignaturePad';
import { SignaturePad } from '~/components/SignaturePad';
import type { Signature, SigTab } from '~/features/pdf-sign/logic';

interface SignatureChooserProps {
  sigTab: () => SigTab;
  setSigTab: (tab: SigTab) => void;
  /** Capture the drawn-pad API when it mounts. */
  onPadApi: (api: SignaturePadApi | null) => void;
  onUseDrawn: () => void;
  onUseTyped: () => void;
  onUpload: (files: File[]) => void;
  typedText: () => string;
  setTypedText: (text: string) => void;
  sig: () => Signature | null;
  stampWidth: () => number;
  setStampWidth: (w: number) => void;
  placing: () => boolean;
  onTogglePlacing: () => void;
  onDiscard: () => void;
}

const TABS: { id: SigTab; label: string }[] = [
  { id: 'draw', label: 'Draw' },
  { id: 'type', label: 'Type' },
  { id: 'upload', label: 'Upload' },
];

export function SignatureChooser(props: SignatureChooserProps) {
  return (
    <div class="panel">
      <div class="panel-title">Signature</div>
      <div class="panel-body">
        <div class="tabs" role="tablist">
          {TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={props.sigTab() === tab.id}
              class={`tab ${props.sigTab() === tab.id ? 'active' : ''}`}
              onClick={() => props.setSigTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Show when={props.sigTab() === 'draw'}>
          <SignaturePad onApi={props.onPadApi} />
          <button
            type="button"
            class="btn btn-primary btn-block"
            style="margin-top: 0.6rem"
            onClick={props.onUseDrawn}
          >
            Use this signature
          </button>
        </Show>
        <Show when={props.sigTab() === 'type'}>
          <div class="field">
            <span>Your name</span>
            <input
              type="text"
              value={props.typedText()}
              onInput={(e) => props.setTypedText(e.currentTarget.value)}
              placeholder="e.g. Alex Rivera"
              style="font-family: cursive; font-size: 1.1rem"
            />
          </div>
          <button
            type="button"
            class="btn btn-primary btn-block"
            style="margin-top: 0.4rem"
            onClick={props.onUseTyped}
          >
            Use this signature
          </button>
        </Show>
        <Show when={props.sigTab() === 'upload'}>
          <DropZone
            accept="image/png,image/jpeg,image/webp"
            title="Drop a signature image"
            subtitle="PNG with transparency works best"
            onFiles={props.onUpload}
          />
        </Show>
        <Show when={props.sig()}>
          {(sig) => (
            <div>
              <div class="sig-preview">
                <img src={sig().dataUrl} alt="Current signature" />
                <span class="file-size">
                  {sig().width}×{sig().height}px
                </span>
              </div>
              <div class="range-row" style="margin-top: 0.5rem">
                <input
                  type="range"
                  min={60}
                  max={420}
                  step={5}
                  value={props.stampWidth()}
                  onChange={(e) => props.setStampWidth(Number(e.currentTarget.value))}
                  aria-label="Stamp width"
                />
                <output>{props.stampWidth()}</output>
              </div>
              <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem">
                <button type="button" class="btn btn-sm btn-ghost" onClick={props.onTogglePlacing}>
                  {props.placing() ? 'Stop placing' : 'Place on a page'}
                </button>
                <button type="button" class="btn btn-sm btn-ghost" onClick={props.onDiscard}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
