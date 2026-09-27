/**
 * Live output preview for Combine (handoff P2.3).
 *
 * Presentational: renders the sheet preview images and the "showing
 * first N of M" count. The route owns the preview session (one open
 * PDF.js document) and the debounced re-render logic.
 */
import { For, Show } from 'solid-js';

interface SheetPreviewProps {
  /** Reactive preview state; `total` > 0 makes the block visible. */
  preview: () => { urls: string[]; total: number };
  visible: () => boolean;
}

export function SheetPreview(props: SheetPreviewProps) {
  return (
    <Show when={props.visible()}>
      <div class="sheet-preview">
        <div class="sheet-preview-head">
          <span class="sheet-preview-title">Output preview</span>
          <span class="sheet-preview-count">
            {props.preview().total} {props.preview().total === 1 ? 'sheet' : 'sheets'}
            {props.preview().total > props.preview().urls.length
              ? ` · showing first ${props.preview().urls.length}`
              : ''}
          </span>
        </div>
        <div class="sheet-prev-row">
          <For each={props.preview().urls}>
            {(u) => (
              <img
                class="sheet-prev-img"
                src={u}
                alt="Combined sheet preview"
                loading="lazy"
                draggable={false}
              />
            )}
          </For>
          <Show when={props.preview().total > props.preview().urls.length}>
            <span class="sheet-prev-more">
              +{props.preview().total - props.preview().urls.length} more
            </span>
          </Show>
        </div>
      </div>
    </Show>
  );
}
