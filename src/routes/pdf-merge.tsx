/**
 * Merge tool page: multiple PDFs and images → one PDF.
 *
 * Every page of every file is rendered as a thumbnail in a single
 * "page order" strip. Reordering works on mouse **and** touch:
 *
 *  - tap a tile to select it (multi-select; tap again to deselect),
 *  - drag the ⠿ grip (pointer-based, so it works on touch too) — a
 *    selected grip drags the whole selection as a block,
 *  - the ‹ › arrows nudge the selection (or a single tile) one slot,
 *  - whole files can still be moved up/down as blocks.
 *
 * Live feedback: while dragging, the strip re-orders in place (the block
 * follows the pointer) and every change animates with FLIP (measure →
 * invert → play) so tiles glide into place instead of jumping.
 *
 * State machine: empty → ready (strip populated) → processing → done.
 * Heavy lifting lives in `./logic` (unit-tested, lazy-loaded deps).
 */

import { Meta, Title } from '@solidjs/meta';
import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { AdSlot } from '~/components/AdSlot';
import { ChainNote } from '~/components/ChainBar';
import { AlertIcon, DownloadIcon, SpinnerIcon } from '~/components/Icons';

import { DropZone, ProgressBar, ToolColumns, ToolPage } from '~/components/Shell';
import { imagePageDimensions, type PageSize } from '~/features/image-to-pdf/logic';
import { type MergePageRef, mergePages } from '~/features/pdf-merge/logic';
import { MergeFileList } from '~/features/pdf-merge/MergeFileList';
import { MergePageStrip } from '~/features/pdf-merge/MergePageStrip';
import {
  moveBlockTo as moveBlockToTransform,
  moveFile as moveFileTransform,
  nudgeBlock,
  selectOnTileClick,
} from '~/features/pdf-merge/sequence';
import { useChainedPdf } from '~/lib/chain';
import { saveBlob } from '~/lib/download';
import { cleanFileName, humanSize, nextId, readFileBytes } from '~/lib/files';
import { MAX_EAGER_INPUT_BYTES, MAX_INTERACTIVE_PAGES, MAX_PAGE_THUMBNAILS } from '~/lib/limits';
import { createObjectUrlRegistry } from '~/lib/object-urls';
import { createOperation, isAbortError, type OperationHandle } from '~/lib/operation';
import { renderPageThumbs } from '~/lib/thumbs';
import { type FileItem, isImageFile, isPdfFile, yieldToBrowser } from '~/lib/types';
import { expandAds } from '~/site/ads';
import { siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

interface Item extends FileItem {
  kind: 'pdf' | 'image';
  /** PDF bytes (read up front so the logic module can copy pages once). */
  pdfBytes?: Uint8Array;
  /** PDF: true page count; image: 1. 0 while the PDF is still loading. */
  pageCount: number;
  /** JPEG data URLs for PDF pages. */
  thumbs: string[];
  /** Image-only: one object URL for the preview (decoded once at add time). */
  thumbUrl?: string;
  /** Image-only: pixel dimensions (EXIF orientation applied). */
  imageWidth?: number;
  imageHeight?: number;
  /** Set when the PDF couldn't be rendered (e.g. password-protected). */
  thumbError?: string;
}

/** One page slot in the user-arranged global sequence. */
interface Seq {
  id: string;
  file: string;
  /** 1-based page within the file (images are always page 1). */
  page: number;
}

type Phase = 'empty' | 'ready' | 'processing' | 'done';

const MAX_FILES = 30;
/** Pointer travel (px) before a grip press becomes a drag. */
const DRAG_THRESHOLD = 6;
/** CSS size of the tile's preview area (118px tile − 0.4rem padding). */
const TILE_W = 105;
const TILE_H = 140;

export default function MergePage() {
  const meta = routeMeta['/pdf-merge']!;

  const [items, setItems] = createSignal<Item[]>([]);
  /** Global page order — the strip renders this, the merge follows it. */
  const [seq, setSeq] = createSignal<Seq[]>([]);
  const [phase, setPhase] = createSignal<Phase>('empty');
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal({ done: 0, total: 1, label: '' });
  const [result, setResult] = createSignal<{ bytes: Uint8Array; name: string } | null>(null);

  /** Multi-selected tiles (by seq id); empty = nothing selected. */
  const [selected, setSelected] = createSignal<string[]>([]);
  /** Tile id under the drag grip (null = not dragging). */
  const [dragging, setDragging] = createSignal<string | null>(null);
  /** Live insertion index (into the non-dragged tiles) while dragging. */
  const [dragIdx, setDragIdx] = createSignal<number | null>(null);

  const [pageSize, setPageSize] = createSignal<PageSize>('fit');
  const [margin, setMargin] = createSignal(0);

  /** Pick up a result chained from another tool ("Continue with …").
   *  Lambda: `addFiles` is defined below; the hook invokes it in onMount. */
  const chain = useChainedPdf((f) => addFiles([f]));

  // Object URLs are route-owned resources; always release them on unmount
  // (handoff P0.4) — Start over / remove revoke individually.
  const urls = createObjectUrlRegistry();
  onCleanup(() => urls.clear());

  /** Cancellation for the in-flight merge (P1.6). */
  let opHandle: OperationHandle | null = null;
  onCleanup(() => opHandle?.cancel());

  /** Cleanup for a grip drag in flight (navigation mid-drag, P1.7). */
  let dragCleanup: (() => void) | null = null;
  onCleanup(() => dragCleanup?.());

  /**
   * CSS page frame for an image tile. The image itself is decoded once (one
   * object URL); page-size/margin changes only recompute these styles —
   * the same geometry the output writer uses (`imagePageDimensions`).
   */
  const imagePreviewStyle = (item: { imageWidth?: number; imageHeight?: number }) => {
    const [pw, ph] = imagePageDimensions(item.imageWidth ?? 4, item.imageHeight ?? 3, pageSize());
    const scale = Math.min(TILE_W / pw, TILE_H / ph);
    const w = Math.max(1, Math.round(pw * scale));
    const h = Math.max(1, Math.round(ph * scale));
    const marginPx = Math.max(0, Math.round((margin() / pw) * w));
    return { width: `${w}px`, height: `${h}px`, '--preview-margin': `${marginPx}px` } as const;
  };

  const itemMap = createMemo(() => new Map(items().map((i) => [i.id, i])));
  const itemOf = (id: string) => itemMap().get(id);
  const selectedSet = createMemo(() => new Set(selected()));

  /** The block being dragged: the selection if it includes the grabbed
   *  tile, otherwise just that tile. */
  const dragBlock = createMemo<Set<string>>(() => {
    const d = dragging();
    if (!d) return new Set();
    const sel = selectedSet();
    return sel.has(d) ? sel : new Set([d]);
  });

  /** What the strip renders: the live re-ordered preview while dragging,
   *  the committed order otherwise. */
  const previewSeq = createMemo<Seq[]>(() => {
    if (!dragging()) return seq();
    const rest = seq().filter((s) => !dragBlock().has(s.id));
    return moveBlockToTransform(seq(), dragBlock(), dragIdx() ?? rest.length);
  });

  /* ---------------- FLIP animation ------------------------------------ */
  const tileEls = new Map<string, HTMLLIElement>();

  /** Run `apply` (a seq/preview change) and animate every tile from its
   *  old slot to its new one (First-Last-Invert-Play). */
  const flip = (duration: number, apply: () => void) => {
    const first = new Map<string, DOMRect>();
    for (const [id, el] of tileEls) first.set(id, el.getBoundingClientRect());
    apply();
    requestAnimationFrame(() => {
      for (const [id, el] of tileEls) {
        const f = first.get(id);
        if (!f) continue;
        const l = el.getBoundingClientRect();
        const dx = f.x - l.x;
        const dy = f.y - l.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration, easing: 'cubic-bezier(0.2, 0.8, 0.25, 1)' },
        );
      }
    });
  };

  /* ---------------- selection ----------------------------------------- */

  /** Last tile clicked/tapped — the anchor for Shift+click ranges. */
  const [anchor, setAnchor] = createSignal<string | null>(null);

  const toggleSelect = (e: MouseEvent, id: string) => {
    const r = selectOnTileClick(
      seq().map((s) => s.id),
      selected(),
      id,
      e.shiftKey,
      anchor(),
    );
    setSelected(r.ids);
    setAnchor(r.anchor);
  };

  /* ---------------- reordering ---------------------------------------- */

  /** Nudge the selection (or a single tile) one slot left/right. The
   *  selection moves as a unit; non-selected tiles fill the vacated slot. */
  const nudgeSelection = (tileId: string, dir: -1 | 1) => {
    const next = nudgeBlock(seq(), new Set(selected()), tileId, dir);
    if (next) flip(240, () => setSeq(next));
  };

  /** Pointer-based drag (mouse + touch): starts on a grip, previews the
   *  re-order live, commits on release. */
  const startGripDrag = (e: PointerEvent, tileId: string) => {
    if (phase() !== 'ready' || e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    let active = false;

    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        active = true;
        document.body.classList.add('seq-dragging');
        // Stable starting position: the block's current slot.
        const list = seq();
        const block = dragBlockAt(tileId);
        const firstPos = list.findIndex((s) => block.has(s.id));
        setDragging(tileId);
        setDragIdx(list.slice(0, firstPos).filter((s) => !block.has(s.id)).length);
      }
      // Insertion index from the tiles' *live* rects (not elementFromPoint):
      // the first rest tile whose center is left of the pointer receives
      // the block before it. Right of every rest center, the block appends
      // only past the last tile's right edge — over the strip background or
      // the dragged block itself it keeps its current position (the block
      // follows the pointer, so the pointer often rides on it).
      const strip = document.querySelector('.page-strip');
      if (!strip) return;
      const block = dragBlock();
      const rest = seq().filter((s) => !block.has(s.id));
      const restEls = [...strip.querySelectorAll<HTMLElement>('.seq-tile[data-seq-id]')]
        .map((el) => ({ id: el.dataset.seqId!, box: el.getBoundingClientRect() }))
        .filter((x) => !block.has(x.id));
      const yOk = (b: DOMRect) => ev.clientY >= b.top - 40 && ev.clientY <= b.bottom + 40;
      let idx: number | null = null;
      for (const x of restEls) {
        if (!yOk(x.box)) continue;
        if (ev.clientX < x.box.left + x.box.width / 2) {
          idx = rest.findIndex((s) => s.id === x.id);
          break;
        }
      }
      if (idx === null) {
        const last = restEls[restEls.length - 1];
        if (last && yOk(last.box) && ev.clientX > last.box.right) idx = rest.length;
        else idx = dragIdx() ?? rest.length;
      }
      if (idx < 0) idx = rest.length;
      // Live preview moves are instant (no FLIP): in-flight transforms
      // would shift the rects mid-drag. FLIP plays on commit instead.
      if (idx !== dragIdx()) setDragIdx(idx);
    };

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('seq-dragging');
      dragCleanup = null;
      if (active) {
        flip(240, () => {
          if (commit) setSeq([...previewSeq()]);
          setDragging(null);
          setDragIdx(null);
        });
      }
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && active) finish(false);
    };
    // If the route unmounts mid-drag (P1.7), onCleanup runs this.
    dragCleanup = () => finish(false);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
  };

  /** Block id-set for a would-be drag of `tileId` (selection-aware). */
  const dragBlockAt = (tileId: string): Set<string> => {
    const sel = selectedSet();
    return sel.has(tileId) ? sel : new Set([tileId]);
  };

  /** Move a whole file's pages (in their current relative order) one file
   *  position up/down, keeping them contiguous. */
  const moveFile = (id: string, dir: -1 | 1) => {
    const r = moveFileTransform(
      items().map((x) => x.id),
      seq(),
      id,
      dir,
    );
    if (!r) return;
    const pos = new Map(r.fileOrder.map((fid, i) => [fid, i]));
    flip(240, () => {
      setItems([...items()].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0)));
      setSeq(r.order);
    });
  };

  const baseName = () => {
    const first = items()[0];
    if (items().length === 1 && first) return first.name.replace(/\.[^.]+$/, '') || 'merged';
    return 'merged';
  };

  const totalInputSize = () => items().reduce((sum, i) => sum + i.size, 0);

  /** Patch one item in the list. */
  const patchItem = (id: string, patch: Partial<Item>) => {
    setItems(items().map((i) => (i.id === id ? { ...i, ...patch } : i)));
  };

  const addFiles = async (files: File[]) => {
    const errors: string[] = [];
    const rejected: string[] = [];
    const accepted: File[] = [];

    for (const file of files) {
      if (isPdfFile(file) || isImageFile(file)) accepted.push(file);
      else rejected.push(cleanFileName(file.name));
    }
    const truncated = accepted.length > MAX_FILES - items().length;
    const toAdd = accepted.slice(0, MAX_FILES - items().length);

    if (rejected.length > 0) {
      errors.push(
        `Not PDF or images: ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? '…' : ''}`,
      );
    }
    if (truncated) errors.push(`Limit is ${MAX_FILES} files — extras were skipped.`);
    setError(errors.join(' '));

    // Global budgets: one thumb per page across all files (P0.2), a cap on
    // interactive pages, and a cap on eager in-memory bytes (P1.4).
    let thumbBudget = MAX_PAGE_THUMBNAILS - items().reduce((sum, i) => sum + i.thumbs.length, 0);

    for (const file of toAdd) {
      if (pageTotal() >= MAX_INTERACTIVE_PAGES) {
        errors.push(
          `Page limit is ${MAX_INTERACTIVE_PAGES} — remaining files were skipped. Remove pages or files to add more.`,
        );
        break;
      }
      const usedBytes = items().reduce((sum, i) => sum + i.size, 0);
      if (usedBytes + file.size > MAX_EAGER_INPUT_BYTES) {
        errors.push(
          `Total size limit is ${Math.round(MAX_EAGER_INPUT_BYTES / 1024 / 1024)} MB of inputs — "${cleanFileName(file.name)}" was skipped.`,
        );
        continue;
      }
      await yieldToBrowser();
      const kind = isPdfFile(file) ? 'pdf' : 'image';
      const id = nextId('file');

      if (kind === 'image') {
        // Decode once (dimensions for the output-aware preview frame); the
        // preview itself is CSS-only and reacts to size/margin changes.
        const thumbUrl = urls.create(file);
        let imageWidth = 4;
        let imageHeight = 3;
        try {
          const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
          imageWidth = bitmap.width;
          imageHeight = bitmap.height;
          bitmap.close();
        } catch {
          // Decode failures surface as a real error at merge time; the
          // tile falls back to a 4:3 frame until then.
        }
        setItems([
          ...items(),
          {
            id,
            name: cleanFileName(file.name),
            size: file.size,
            type: file.type,
            file,
            kind,
            pageCount: 1,
            thumbs: [],
            thumbUrl,
            imageWidth,
            imageHeight,
          },
        ]);
        setSeq([...seq(), { id: `${id}::1`, file: id, page: 1 }]);
        continue;
      }

      let pdfBytes: Uint8Array | null = null;
      try {
        pdfBytes = new Uint8Array(await readFileBytes(file));
      } catch {
        errors.push(`Couldn't read ${cleanFileName(file.name)}.`);
        continue;
      }

      // Add immediately (strip shows "loading…"), then render pages in the
      // background and append the file's page slots when they're ready.
      setItems([
        ...items(),
        {
          id,
          name: cleanFileName(file.name),
          size: file.size,
          type: file.type,
          file,
          kind,
          pdfBytes,
          pageCount: 0,
          thumbs: [],
        },
      ]);

      const r = await renderPageThumbs(pdfBytes.slice(), {
        targetWidth: 110,
        maxThumbs: Math.max(0, thumbBudget),
        maxDocumentPages: MAX_INTERACTIVE_PAGES - pageTotal(),
      });
      if (r.error) {
        // Drop the eager bytes too — the file cannot participate.
        patchItem(id, { pdfBytes: undefined, pageCount: 0, thumbError: r.error });
        errors.push(`${cleanFileName(file.name)}: ${r.error}`);
        continue;
      }
      // File may have been removed while loading.
      if (!itemOf(id)) continue;
      thumbBudget -= r.thumbs.length;
      patchItem(id, { pageCount: r.count, thumbs: r.thumbs });
      const pages: Seq[] = Array.from({ length: r.count }, (_, i) => ({
        id: `${id}::${i + 1}`,
        file: id,
        page: i + 1,
      }));
      setSeq([...seq(), ...pages]);
    }

    if (errors.length > 0) setError(errors.join(' '));
    if (toAdd.length > 0) {
      setResult(null);
      setPhase('ready');
    }
  };

  const remove = (id: string) => {
    const item = itemOf(id);
    if (item?.thumbUrl) urls.revoke(item.thumbUrl);
    setItems(items().filter((x) => x.id !== id));
    setSeq(seq().filter((x) => x.file !== id));
    // Drop selections of removed pages.
    setSelected(selected().filter((sid) => seq().some((s) => s.id === sid)));
    if (items().length === 0) {
      setPhase('empty');
      setResult(null);
    }
  };

  const process = async () => {
    const list = seq();
    if (list.length < 2 || phase() !== 'ready') return;
    expandAds();
    setPhase('processing');
    setError('');
    setResult(null);
    setProgress({ done: 0, total: list.length, label: 'Starting…' });
    const handle = createOperation((done, total, label) =>
      setProgress({ done, total, label: label ?? '' }),
    );
    opHandle = handle;
    try {
      const refs: MergePageRef[] = list.map((s) => {
        const it = itemOf(s.file)!;
        return it.kind === 'image'
          ? { kind: 'image', name: it.name, file: it.file }
          : { kind: 'pdf', name: it.name, bytes: it.pdfBytes!, page: s.page };
      });
      const bytes = await mergePages(
        refs,
        { pageSize: pageSize(), marginPt: margin(), op: handle.op },
        (done, total, label) => setProgress({ done, total, label: label ?? '' }),
      );
      setResult({ bytes, name: `${baseName()}.pdf` });
      setPhase('done');
    } catch (err) {
      if (isAbortError(err)) {
        setPhase('ready');
        setProgress({ done: 0, total: list.length, label: '' });
        return;
      }
      setPhase('ready');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      opHandle = null;
    }
  };

  const download = () => {
    const r = result();
    if (r) saveBlob(r.bytes, r.name, 'application/pdf');
  };

  const startOver = () => {
    urls.clear();
    setItems([]);
    setSeq([]);
    setSelected([]);
    setAnchor(null);
    setDragging(null);
    setDragIdx(null);
    setPhase('empty');
    setResult(null);
  };

  const pageTotal = () => seq().length;
  const loadingFiles = () => items().some((i) => i.kind === 'pdf' && i.pageCount === 0);

  return (
    <>
      <Title>{meta.title}</Title>
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/pdf-merge`} />
      {meta.image && <Meta property="og:image" content={meta.image} />}
      <script type="application/ld+json" innerHTML={JSON.stringify(jsonLdFor('/pdf-merge'))} />

      <ToolPage
        title="Merge PDF"
        lede="Combine several PDFs — and JPG, PNG, WebP images — into a single PDF. Every page is rendered so you can reorder individual pages — drag, tap to multi-select, or nudge with the arrows — then download. Nothing is uploaded."
        related={[
          { path: '/pdf-combine', label: 'Combine pages' },
          { path: '/image-to-pdf', label: 'Image to PDF' },
          { path: '/pdf-compress', label: 'Compress PDF' },
        ]}
        chainResult={() => {
          const r = result();
          return r ? { bytes: r.bytes, name: r.name } : null;
        }}
      >
        <ToolColumns
          aside={
            <>
              <div class="panel">
                <div class="panel-body">
                  <p style="font-size: 0.95rem; margin: 0 0 0.75rem; font-weight: 600">
                    Image pages
                  </p>
                  <div class="opt-group">
                    <label for="mergePageSize">Page size</label>
                    <select
                      id="mergePageSize"
                      value={pageSize()}
                      onChange={(e) => setPageSize(e.currentTarget.value as PageSize)}
                    >
                      <option value="fit">Fit to image</option>
                      <option value="a4">A4</option>
                      <option value="letter">Letter</option>
                      <option value="legal">Legal</option>
                    </select>
                    <p class="opt-hint">Applies to images; PDF pages keep their own size.</p>
                  </div>
                  <div class="opt-group">
                    <label for="mergeMargin">Margins</label>
                    <select
                      id="mergeMargin"
                      value={margin()}
                      onChange={(e) => setMargin(Number(e.currentTarget.value))}
                    >
                      <option value={0}>None</option>
                      <option value={8}>Slim</option>
                      <option value={24}>Comfortable</option>
                    </select>
                  </div>
                </div>
              </div>
              <div class="panel">
                <div class="panel-body">
                  <h3>Order matters</h3>
                  <p style="font-size: 0.88rem; color: var(--ink-muted); margin: 0">
                    The merge follows the page strip below exactly. Tap pages to select, Ctrl/⌘+tap
                    to add more, Shift+tap for a range, then drag the ⠿ grip to move one page or the
                    whole selection — or use the arrows. Image previews update live as you change
                    page size or margins. Password-protected PDFs can't be merged.
                  </p>
                </div>
              </div>
              <AdSlot slot="tool-bottom" className="aside-ad" />
            </>
          }
        >
          <div class="panel">
            <div class="panel-body">
              <ChainNote note={chain.note} dismiss={chain.dismissNote} />
              <DropZone
                accept="application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
                multiple
                title="Drop PDFs and images here"
                subtitle="PDF, JPG, PNG, WebP, GIF, BMP, AVIF — mix and match"
                busy={phase() === 'processing'}
                onFiles={addFiles}
              />
              <MergeFileList
                items={items}
                onMoveUp={(id) => moveFile(id, -1)}
                onMoveDown={(id) => moveFile(id, 1)}
                onRemove={remove}
                disabled={() => phase() !== 'ready'}
              />
              <MergePageStrip
                seq={previewSeq}
                itemOf={itemOf}
                selected={selectedSet}
                dragBlock={dragBlock}
                dragging={dragging}
                loading={loadingFiles}
                pageTotal={pageTotal}
                onTileClick={toggleSelect}
                onGripDown={startGripDrag}
                onNudge={nudgeSelection}
                onClearSelection={() => setSelected([])}
                registerTile={(id, el) => {
                  if (el) tileEls.set(id, el);
                  else tileEls.delete(id);
                }}
                imagePreviewStyle={imagePreviewStyle}
                disabled={() => phase() !== 'ready'}
              />
              <Show when={error()}>
                <div class="error-card" role="alert">
                  <AlertIcon />
                  <span>{error()}</span>
                </div>
              </Show>
            </div>
          </div>

          <Show when={items().length > 0 && phase() !== 'processing' && phase() !== 'done'}>
            <div class="panel cta">
              <div class="panel-body">
                <button
                  type="button"
                  class="btn btn-primary btn-block"
                  onClick={process}
                  disabled={items().length < 2 || pageTotal() < 2}
                >
                  <SpinnerIcon />
                  {pageTotal() > 0
                    ? `Merge ${pageTotal()} ${pageTotal() === 1 ? 'page' : 'pages'} into one PDF`
                    : 'Merge files into one PDF'}
                </button>
              </div>
            </div>
          </Show>

          <Show when={phase() === 'processing'}>
            <div class="panel">
              <ProgressBar
                done={progress().done}
                total={progress().total}
                label={progress().label}
              />
            </div>
            <AdSlot slot="processing" className="processing-ad" />
          </Show>

          <Show when={phase() === 'done' && result()}>
            <div class="panel">
              <div class="result-card">
                <div class="result-size">
                  <span class="was">{humanSize(totalInputSize())} of input</span>
                  <span class="now">{humanSize(result()!.bytes.byteLength)}</span>
                  <span class="delta neutral">
                    PDF · {pageTotal()} {pageTotal() === 1 ? 'page' : 'pages'} merged
                  </span>
                </div>
                <div class="result-actions">
                  <button type="button" class="btn btn-primary" onClick={download}>
                    <DownloadIcon />
                    Download PDF
                  </button>
                  <button type="button" class="btn btn-ghost" onClick={startOver}>
                    Start over
                  </button>
                </div>
              </div>
            </div>
          </Show>
        </ToolColumns>
      </ToolPage>
    </>
  );
}
