/**
 * The vertical page stages for Sign & Fill (handoff P2.3).
 *
 * Presentational: renders one stage per page (canvas + placed stamps +
 * page badge) and the selected-stamp controls. The route owns the lazy
 * renderer (canvas registration callbacks), the stamp state, and the
 * intersection observer that drives the render window.
 */
import { For, Show } from 'solid-js';
import { DownloadIcon, TrashIcon } from '~/components/Icons';
import type { StampView } from '~/features/pdf-sign/logic';
import type { PageMeta } from '~/features/pdf-sign/page-renderer';

interface PdfStageProps {
  pageMeta: () => PageMeta[];
  stamps: () => StampView[];
  selected: () => string | null;
  placing: () => boolean;
  registerStage: (page: number, el: HTMLDivElement | null) => void;
  registerCanvas: (page: number, el: HTMLCanvasElement | null) => void;
  onStageClick: (page: number) => (e: MouseEvent) => void;
  onStampClick: (id: string) => void;
  onStampRemoveKey: (id: string) => void;
  selectedStamp: () => StampView | null;
  onResizeStamp: (id: string, width: number) => void;
  onRemoveStamp: (id: string) => void;
  /** Download CTA label/disabled state is route-owned; rendered here so
   *  the stage block stays self-contained. */
  downloadLabel: () => string;
  downloadDisabled: () => boolean;
  onDownload: () => void;
}

export function PdfStage(props: PdfStageProps) {
  return (
    <div class="pages-vertical">
      <For each={props.pageMeta()}>
        {(m, index) => {
          const p = index() + 1;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: canvas-like placement surface; stamps are focusable buttons
            <div
              class="stage"
              data-page={p}
              data-placing={props.placing() ? 'true' : 'false'}
              onClick={props.onStageClick(p)}
              ref={(el) => props.registerStage(p, el)}
            >
              <canvas
                class="stage-canvas"
                // aspect-ratio gives unrendered (0×0) canvases a
                // page-shaped placeholder; rendered canvases use their
                // own intrinsic ratio.
                style={{ 'aspect-ratio': `${m.widthPt} / ${m.heightPt}` }}
                ref={(el) => props.registerCanvas(p, el)}
              />
              <For each={props.stamps().filter((s) => s.page === p)}>
                {(s) => (
                  <button
                    type="button"
                    class={`stamp ${s.id === props.selected() ? 'selected' : ''}`}
                    style={{
                      left: `${s.x}px`,
                      top: `${s.y}px`,
                      width: `${s.w}px`,
                      height: `${s.h}px`,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onStampClick(s.id);
                    }}
                    aria-label={`Signature on page ${p}: press Enter to remove`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'Delete') props.onStampRemoveKey(s.id);
                    }}
                  >
                    <img src={s.dataUrl} alt="" />
                  </button>
                )}
              </For>
              <span class="page-badge">{p}</span>
            </div>
          );
        }}
      </For>

      <Show when={props.selectedStamp()}>
        <div class="panel stamp-controls">
          <div
            class="panel-body"
            style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap"
          >
            <label class="opt-label" for="stampw" style="margin: 0">
              Width
            </label>
            <input
              id="stampw"
              type="range"
              min={60}
              max={420}
              step={5}
              value={props.selectedStamp()!.w}
              onChange={(e) =>
                props.onResizeStamp(props.selectedStamp()!.id, Number(e.currentTarget.value))
              }
              style="flex: 1; min-width: 140px"
            />
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onClick={() => props.onRemoveStamp(props.selectedStamp()!.id)}
            >
              <TrashIcon /> Remove
            </button>
          </div>
        </div>
      </Show>

      <div class="panel cta">
        <div class="panel-body">
          <button
            type="button"
            class="btn btn-primary btn-block"
            onClick={props.onDownload}
            disabled={props.downloadDisabled()}
          >
            <DownloadIcon />
            {props.downloadLabel()}
          </button>
        </div>
      </div>
    </div>
  );
}
