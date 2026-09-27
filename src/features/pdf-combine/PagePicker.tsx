/**
 * Page picker grid for Combine (handoff P2.3).
 *
 * Presentational: the All/None row and the thumbnail page grid. The
 * route owns the selection, the thumbnails, and the toggle logic.
 */
import { For, Show } from 'solid-js';
import { CheckIcon } from '~/components/Icons';

interface PagePickerProps {
  visible: () => boolean;
  pageCount: () => number;
  thumbs: () => string[];
  selected: () => number[];
  selectedCount: () => number;
  onToggle: (page: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  /** Disable the tiles (e.g. while processing). */
  disabled: () => boolean;
}

export function PagePicker(props: PagePickerProps) {
  return (
    <Show when={props.visible()}>
      <div style="display: flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0">
        <button type="button" class="btn btn-sm btn-ghost" onClick={props.onSelectAll}>
          <CheckIcon /> All
        </button>
        <button type="button" class="btn btn-sm btn-ghost" onClick={props.onSelectNone}>
          None
        </button>
        <span style="font-size: 0.85rem; color: var(--ink-muted); margin-left: auto">
          {props.selectedCount()} selected
        </span>
      </div>
      <fieldset class="page-grid" aria-label="Select pages to combine">
        <For each={Array.from({ length: props.pageCount() }, (_, i) => i + 1)}>
          {(n) => (
            <button
              type="button"
              class="page-tile"
              aria-pressed={props.selected().includes(n)}
              onClick={() => props.onToggle(n)}
              disabled={props.disabled()}
            >
              <Show when={props.thumbs()[n - 1]}>
                <img
                  class="page-tile-img"
                  src={props.thumbs()[n - 1]!}
                  alt=""
                  loading="lazy"
                  draggable={false}
                />
              </Show>
              <span class="page-num">{n}</span>
            </button>
          )}
        </For>
      </fieldset>
    </Show>
  );
}
