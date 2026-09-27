/**
 * The vertical page stages for Sign & Fill (handoff P2.3).
 *
 * Presentational: renders one stage per page (canvas + placed stamps +
 * page badge) and the selected-stamp controls. The route owns the lazy
 * renderer (canvas registration callbacks), the stamp state, and the
 * intersection observer that drives the render window.
 *
 * Stamps are stored in PDF points by the route; this component converts to
 * display px with `pxPerPt` (the canvas's live scale) and translates drag
 * gestures back into points, so placement survives window resizing and
 * downloads embed exactly what the user sees.
 *
 * Drag mechanics: immutable stamp-state updates replace the stamp node in
 * Solid's `For`, so live position/size changes use direct DOM writes
 * (transform / width / height on the same node) to keep pointer capture
 * stable. Only pointerup commits the final PDF-point position to state.
 * Pointer capture is taken on the STAGE element (stable for the life of
 * the page), native image dragging is disabled, and selecting happens on
 * pointerdown, so a plain click selects while a drag moves.
 */
import { For, Show } from 'solid-js';
import { CloseIcon, DownloadIcon, TrashIcon } from '~/components/Icons';
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
  onStampRemoveKey: (id: string) => void;
  /** Reactive display scale for a page: CSS pixels per PDF point. */
  pxPerPt: (page: number) => number;
  /** Select a stamp (pointerdown; also the drag start point). */
  onStampSelect: (id: string) => void;
  /** Move a stamp to (x, y) in PDF points (route clamps to the page). */
  onStampMove: (id: string, x: number, y: number) => void;
  selectedStamp: () => StampView | null;
  /** Resize a stamp to a width in PDF points (slider or corner handle). */
  onResizeStamp: (id: string, width: number) => void;
  onRemoveStamp: (id: string) => void;
  /** Download CTA label/disabled state is route-owned; rendered here so
   *  the stage block stays self-contained. */
  downloadLabel: () => string;
  downloadDisabled: () => boolean;
  onDownload: () => void;
}

type Gesture =
  | {
      kind: 'move';
      id: string;
      page: number;
      px: number;
      py: number;
      x: number;
      y: number;
      w: number;
      h: number;
      dx: number; // live clamped delta, display px
      dy: number;
      el: HTMLElement;
    }
  | {
      kind: 'resize';
      id: string;
      page: number;
      px: number;
      py: number;
      x: number;
      y: number;
      w: number; // start width, PDF pt
      h: number; // start height, PDF pt
      wPt: number; // live clamped width, PDF pt
      el: HTMLElement;
    };

export function PdfStage(props: PdfStageProps) {
  /** Stage elements (stable per page) — the pointer-capture targets. */
  const stageEls = new Map<number, HTMLDivElement>();
  /** The in-flight gesture (one at a time). Live deltas are clamped
   *  against the page bounds so the stamp never previews off-page. */
  let active: Gesture | null = null;
  /** Timestamp (ms) of the most recent gesture end. The browser dispatches a
   *  synthetic click on the stage right after a pointerup; a microtask flag
   *  can't reliably catch it (the click arrives in a later task on some
   *  engines, e.g. Safari), so the stage's click handler ignores any click
   *  within a short window after a gesture ends. That's what stops ending a
   *  drag (or a click on an existing stamp) from placing a fresh stamp. */
  let lastGestureEnd = 0;

  const beginGesture = (e: PointerEvent, g: Gesture) => {
    if (active) return; // one gesture at a time
    const el = stageEls.get(g.page);
    if (!el) return;
    active = g;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  };

  /** Commit + end the in-flight gesture, converting the live display-px
   *  state into a PDF-point update (the route re-clamps on commit). */
  const endGesture = (e: PointerEvent) => {
    if (!active) return;
    const g = active;
    const ds = props.pxPerPt(g.page);
    if (g.kind === 'move') {
      // Skip the commit (and the node swap) when nothing moved: a plain
      // click already selected the stamp on pointerdown.
      if (g.dx !== 0 || g.dy !== 0) {
        props.onStampMove(g.id, g.x + g.dx / ds, g.y + g.dy / ds);
      }
    } else if (Math.abs(g.wPt - g.w) > 0.001) {
      props.onResizeStamp(g.id, g.wPt);
    }
    const el = stageEls.get(g.page);
    if (el) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      el.classList.remove('dragging');
    }
    active = null;
    // Remember when the gesture ended: the browser dispatches a synthetic
    // click on the stage right after this pointerup, and the stage's click
    // handler ignores clicks within the window (see onClick) so ending a
    // drag never places a fresh stamp.
    lastGestureEnd = Date.now();
  };

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
              onClick={(e) => {
                // Ignore the synthetic click that follows a just-ended gesture
                // (drag / resize / click-on-a-stamp) so it never places a new
                // stamp. A real placement click has no recent gesture and
                // passes through.
                if (Date.now() - lastGestureEnd < 400) return;
                props.onStageClick(p)(e);
              }}
              onPointerMove={(e) => {
                if (!active) return;
                const ds = props.pxPerPt(active.page);
                if (active.kind === 'move') {
                  // Live position: direct DOM write on the same node so
                  // pointer capture remains stable. Committed on pointerup.
                  const maxX = (m.widthPt - active.x - active.w) * ds;
                  const minX = -active.x * ds;
                  const maxY = (m.heightPt - active.y - active.h) * ds;
                  const minY = -active.y * ds;
                  active.dx = Math.min(maxX, Math.max(minX, e.clientX - active.px));
                  active.dy = Math.min(maxY, Math.max(minY, e.clientY - active.py));
                  active.el.style.transform = `translate(${active.dx}px, ${active.dy}px)`;
                } else {
                  // Live size: direct width/height writes (aspect held by
                  // the commit-side clamp; the img reflows via contain).
                  const ratio = active.w > 0 ? active.h / active.w : 0.4;
                  const rawW = active.w + (e.clientX - active.px) / ds;
                  const maxW = Math.max(
                    0,
                    Math.min(m.widthPt - active.x, (m.heightPt - active.y) / ratio),
                  );
                  const minW = Math.min(40, maxW);
                  const w = Math.min(Math.max(minW, rawW), maxW);
                  active.wPt = w;
                  active.el.style.width = `${w * ds}px`;
                  active.el.style.height = `${w * ratio * ds}px`;
                }
              }}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              ref={(el) => {
                props.registerStage(p, el);
                if (el) stageEls.set(p, el);
                else stageEls.delete(p);
              }}
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
                  // The stamp is a compound widget: a draggable/selectable
                  // surface that must also hold a nested remove <button> and
                  // the resize handle, so it can't be a semantic <button>.
                  // A focusable role="button" div is the closest accessible
                  // shape; the two a11y heuristics below don't fit this
                  // pattern (tabindex is set, and the nested button is the
                  // point).
                  // biome-ignore lint/a11y/useSemanticElements: nested remove <button> precludes a semantic <button>
                  // biome-ignore lint/a11y/useFocusableInteractive: tabindex={0} is set; lint false-positives on the nested interactive child
                  <div
                    class={`stamp ${s.id === props.selected() ? 'selected' : ''}`}
                    style={{
                      left: `${s.x * props.pxPerPt(p)}px`,
                      top: `${s.y * props.pxPerPt(p)}px`,
                      width: `${s.w * props.pxPerPt(p)}px`,
                      height: `${s.h * props.pxPerPt(p)}px`,
                    }}
                    role="button"
                    tabindex={0}
                    onPointerDown={(e) => {
                      if (e.pointerType === 'mouse' && e.button !== 0) return;
                      e.stopPropagation();
                      props.onStampSelect(s.id);
                      beginGesture(e, {
                        kind: 'move',
                        id: s.id,
                        page: p,
                        px: e.clientX,
                        py: e.clientY,
                        x: s.x,
                        y: s.y,
                        w: s.w,
                        h: s.h,
                        dx: 0,
                        dy: 0,
                        el: e.currentTarget,
                      });
                    }}
                    aria-label={`Signature on page ${p}: drag to move, Enter or Delete to remove`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'Delete') props.onStampRemoveKey(s.id);
                    }}
                  >
                    <img src={s.dataUrl} alt="" draggable={false} />
                    <Show when={s.id === props.selected()}>
                      <button
                        type="button"
                        class="stamp-remove"
                        aria-label="Remove signature"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onRemoveStamp(s.id);
                        }}
                      >
                        <CloseIcon />
                      </button>
                      <span
                        class="stamp-resize"
                        onPointerDown={(e) => {
                          if (e.pointerType === 'mouse' && e.button !== 0) return;
                          e.stopPropagation();
                          const btn = e.currentTarget.parentElement;
                          if (!(btn instanceof HTMLElement)) return;
                          beginGesture(e, {
                            kind: 'resize',
                            id: s.id,
                            page: p,
                            px: e.clientX,
                            py: e.clientY,
                            x: s.x,
                            y: s.y,
                            w: s.w,
                            h: s.h,
                            wPt: s.w,
                            el: btn,
                          });
                        }}
                      />
                    </Show>
                  </div>
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
              min={40}
              max={400}
              step={5}
              value={props.selectedStamp()!.w}
              onChange={(e) =>
                props.onResizeStamp(props.selectedStamp()!.id, Number(e.currentTarget.value))
              }
              style="flex: 1; min-width: 140px"
              aria-label="Selected stamp width in points"
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
