/**
 * The global page-order strip for the Merge tool (handoff P2.3).
 *
 * Owns the tile DOM: per-tile refs for FLIP animation, the grip
 * pointer-down (the route runs the window-level drag lifecycle),
 * selection state classes, and the arrow nudge controls. The route
 * owns the sequence, selection semantics and the drag engine.
 */
import { For, Show } from 'solid-js';
import { CloseIcon, GripIcon } from '~/components/Icons';
import type { SeqEntry } from '~/features/pdf-merge/sequence';

/** The view of a merge item the strip needs (subset of the route's Item). */
export interface StripItem {
  id: string;
  name: string;
  kind: 'pdf' | 'image';
  /** JPEG data URLs for PDF pages (empty for images/while loading). */
  thumbs: string[];
  /** Image-only: one object URL for the preview (decoded once at add time). */
  thumbUrl?: string;
  /** Image-only: pixel dimensions (EXIF orientation applied). */
  imageWidth?: number;
  imageHeight?: number;
}

interface MergePageStripProps {
  /** The order to render (live drag preview while dragging). */
  seq: () => SeqEntry[];
  itemOf: (fileId: string) => StripItem | undefined;
  selected: () => Set<string>;
  dragBlock: () => Set<string>;
  dragging: () => string | null;
  loading: () => boolean;
  pageTotal: () => number;
  onTileClick: (e: MouseEvent, id: string) => void;
  onGripDown: (e: PointerEvent, id: string) => void;
  onNudge: (id: string, dir: -1 | 1) => void;
  onClearSelection: () => void;
  /** FLIP bookkeeping — the route measures these for animations. */
  registerTile: (id: string, el: HTMLLIElement | null) => void;
  /** CSS page frame for image tiles (shared with the output writer). */
  imagePreviewStyle: (item: StripItem) => Record<string, string>;
  disabled: () => boolean;
}

export function MergePageStrip(props: MergePageStripProps) {
  return (
    <Show when={props.seq().length > 0 || props.loading()}>
      <div class="seq-wrap">
        <div class="seq-head">
          <span class="seq-title">Page order</span>
          <span class="seq-count">
            {props.pageTotal()} {props.pageTotal() === 1 ? 'page' : 'pages'}
          </span>
          <Show when={props.selected().size > 0}>
            <button type="button" class="seq-clear" onClick={props.onClearSelection}>
              <CloseIcon />
              {props.selected().size} selected
            </button>
          </Show>
        </div>
        <ul
          class="page-strip"
          aria-label="Page order: tap tiles to select (Ctrl to add, Shift for a range), drag the grip to reorder"
        >
          <For each={props.seq()}>
            {(s) => {
              const it = () => props.itemOf(s.file);
              const thumb = () => it()?.thumbs[s.page - 1] ?? '';
              return (
                <li
                  class="seq-tile"
                  data-seq-id={s.id}
                  ref={(el) => props.registerTile(s.id, el)}
                  onClick={(e) => props.onTileClick(e, s.id)}
                  classList={{
                    'is-selected': props.selected().has(s.id),
                    'is-dragging': props.dragBlock().has(s.id),
                    'is-drag-source': props.dragging() === s.id,
                  }}
                >
                  <button
                    type="button"
                    class="seq-grip"
                    aria-label={`Drag to reorder page ${s.page} of ${it()?.name}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onPointerDown={(e) => props.onGripDown(e, s.id)}
                  >
                    <GripIcon />
                  </button>
                  {it()?.kind === 'image' && it()?.thumbUrl ? (
                    <div class="seq-image-page" style={props.imagePreviewStyle(it()!)}>
                      <img src={it()!.thumbUrl} alt="" loading="lazy" draggable={false} />
                    </div>
                  ) : thumb() ? (
                    <img class="seq-thumb" src={thumb()} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <div class="seq-thumb seq-thumb-blank">
                      <span>{s.page}</span>
                    </div>
                  )}
                  <span class="seq-chip">p{s.page}</span>
                  <span class="seq-src" title={it()?.name}>
                    {it()?.name}
                  </span>
                  <span class="seq-move">
                    <button
                      type="button"
                      aria-label={`Move page ${s.page} of ${it()?.name} left`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onNudge(s.id, -1);
                      }}
                      disabled={props.disabled()}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      aria-label={`Move page ${s.page} of ${it()?.name} right`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onNudge(s.id, 1);
                      }}
                      disabled={props.disabled()}
                    >
                      ›
                    </button>
                  </span>
                </li>
              );
            }}
          </For>
          <Show when={props.loading()}>
            <li class="seq-tile seq-tile-loading">
              <div class="seq-thumb seq-thumb-blank">
                <span>…</span>
              </div>
              <span class="seq-src">loading pages…</span>
            </li>
          </Show>
        </ul>
      </div>
    </Show>
  );
}
