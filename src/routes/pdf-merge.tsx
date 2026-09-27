/**
 * Merge tool page: multiple PDFs and images → one PDF.
 *
 * Every page of every file is rendered as a small thumbnail in a single
 * "page order" strip; the user reorders individual pages by dragging tiles
 * or using the arrow buttons (files can also be moved as a block). The merge
 * follows the strip exactly (`mergePages` in `./logic`).
 *
 * State machine: empty → ready (strip populated) → processing → done.
 * Heavy lifting lives in `./logic` (unit-tested, lazy-loaded deps).
 */

import { Meta, Title } from '@solidjs/meta';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { AdSlot } from '~/components/AdSlot';
import {
  AlertIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  SpinnerIcon,
  TrashIcon,
} from '~/components/Icons';
import { DropZone, ProgressBar, ToolColumns, ToolPage } from '~/components/Shell';
import type { PageSize } from '~/features/image-to-pdf/logic';
import { type MergePageRef, mergePages } from '~/features/pdf-merge/logic';
import { saveBlob } from '~/lib/download';
import { cleanFileName, humanSize, nextId, readFileBytes } from '~/lib/files';
import { renderPageThumbs } from '~/lib/thumbs';
import { type FileItem, isImageFile, isPdfFile, yieldToBrowser } from '~/lib/types';
import { expandAds } from '~/site/ads';
import { siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

interface Item extends FileItem {
  kind: 'pdf' | 'image';
  /** PDF bytes (read up front so the logic module can copy pages). */
  pdfBytes?: Uint8Array;
  /** PDF: true page count; image: 1. 0 while the PDF is still loading. */
  pageCount: number;
  /** JPEG data URLs for PDF pages (images use `thumbUrl`). */
  thumbs: string[];
  /** Object URL for an image's single page thumbnail. */
  thumbUrl?: string;
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
/** Thumbnail cap per file — beyond this, tiles show the page number only. */
const THUMB_CAP = 200;

export default function MergePage() {
  const meta = routeMeta['/pdf-merge']!;

  const [items, setItems] = createSignal<Item[]>([]);
  /** Global page order — the strip renders this, the merge follows it. */
  const [seq, setSeq] = createSignal<Seq[]>([]);
  const [phase, setPhase] = createSignal<Phase>('empty');
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal({ done: 0, total: 1, label: '' });
  const [result, setResult] = createSignal<{ bytes: Uint8Array; name: string } | null>(null);
  const [dragId, setDragId] = createSignal('');
  const [dragOverId, setDragOverId] = createSignal('');

  const [pageSize, setPageSize] = createSignal<PageSize>('fit');
  const [margin, setMargin] = createSignal(0);

  const itemMap = createMemo(() => new Map(items().map((i) => [i.id, i])));
  const itemOf = (id: string) => itemMap().get(id);

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

    for (const file of toAdd) {
      await yieldToBrowser();
      const kind = isPdfFile(file) ? 'pdf' : 'image';
      const id = nextId('file');

      if (kind === 'image') {
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
            thumbUrl: URL.createObjectURL(file),
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

      const r = await renderPageThumbs(pdfBytes.slice(), 110, THUMB_CAP);
      if (r.error) {
        patchItem(id, { pageCount: 0, thumbError: r.error });
        continue;
      }
      // File may have been removed while loading.
      if (!itemOf(id)) continue;
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

  /** Swap one page one slot left/right in the global sequence. */
  const movePage = (seqId: string, dir: -1 | 1) => {
    const list = [...seq()];
    const from = list.findIndex((x) => x.id === seqId);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= list.length) return;
    const [page] = list.splice(from, 1);
    list.splice(to, 0, page!);
    setSeq(list);
  };

  /** Drag-and-drop: move the dragged page so it lands before `targetId`
   *  (or append to the end when `targetId` is null). */
  const moveSeq = (srcId: string, targetId: string | null) => {
    const list = [...seq()];
    const from = list.findIndex((x) => x.id === srcId);
    if (from < 0) return;
    const [page] = list.splice(from, 1);
    if (targetId === null) {
      list.push(page!);
    } else {
      const to = list.findIndex((x) => x.id === targetId);
      list.splice(to < 0 ? list.length : to, 0, page!);
    }
    setSeq(list);
  };

  /** Move a whole file's pages (in their current relative order) one file
   *  position up/down, keeping them contiguous. */
  const moveFile = (id: string, dir: -1 | 1) => {
    const list = [...items()];
    const from = list.findIndex((x) => x.id === id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= list.length) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item!);
    setItems(list);

    const s = seq();
    const block = s.filter((x) => x.file === id);
    const rest = s.filter((x) => x.file !== id);
    if (block.length === 0) return;
    // The neighbour the file lands next to after the move (the moved file
    // itself sits at index `to` in the spliced list).
    const anchorId = dir === 1 ? list[to - 1]!.id : list[to + 1]!.id;
    let insertAt: number;
    if (dir === 1) {
      // after the anchor file's last page
      let last = -1;
      rest.forEach((x, i) => {
        if (x.file === anchorId) last = i;
      });
      insertAt = last < 0 ? rest.length : last + 1;
    } else {
      // before the anchor file's first page
      insertAt = rest.findIndex((x) => x.file === anchorId);
      if (insertAt < 0) insertAt = 0;
    }
    setSeq([...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)]);
  };

  const remove = (id: string) => {
    const it = itemOf(id);
    if (it?.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    setItems(items().filter((x) => x.id !== id));
    setSeq(seq().filter((x) => x.file !== id));
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
    try {
      const refs: MergePageRef[] = list.map((s) => {
        const it = itemOf(s.file)!;
        return it.kind === 'image'
          ? { kind: 'image', name: it.name, file: it.file }
          : { kind: 'pdf', name: it.name, bytes: it.pdfBytes!, page: s.page };
      });
      const bytes = await mergePages(
        refs,
        { pageSize: pageSize(), marginPt: margin() },
        (done, total, label) => setProgress({ done, total, label: label ?? '' }),
      );
      setResult({ bytes, name: `${baseName()}.pdf` });
      setPhase('done');
      saveBlob(bytes, `${baseName()}.pdf`, 'application/pdf'); // auto-download, like the other tools
    } catch (err) {
      setPhase('ready');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const download = () => {
    const r = result();
    if (r) saveBlob(r.bytes, r.name, 'application/pdf');
  };

  const startOver = () => {
    for (const i of items()) if (i.thumbUrl) URL.revokeObjectURL(i.thumbUrl);
    setItems([]);
    setSeq([]);
    setPhase('empty');
    setResult(null);
    setDragId('');
    setDragOverId('');
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
        lede="Combine several PDFs — and JPG, PNG, WebP images — into a single PDF. Every page is rendered so you can reorder individual pages, then download. Nothing is uploaded."
        related={[
          { path: '/pdf-combine', label: 'Combine pages' },
          { path: '/image-to-pdf', label: 'Image to PDF' },
          { path: '/pdf-compress', label: 'Compress PDF' },
        ]}
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
                    The merge follows the page strip below exactly — drag a tile, use the arrows, or
                    move a whole file up and down. Password-protected PDFs can't be merged.
                  </p>
                </div>
              </div>
              <AdSlot slot="tool-bottom" className="aside-ad" />
            </>
          }
        >
          <div class="panel">
            <div class="panel-body">
              <DropZone
                accept="application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
                multiple
                title="Drop PDFs and images here"
                subtitle="PDF, JPG, PNG, WebP, GIF, BMP, AVIF — mix and match"
                busy={phase() === 'processing'}
                onFiles={addFiles}
              />
              <Show when={items().length > 0}>
                <ul class="filelist" aria-label="Files to merge">
                  <For each={items()}>
                    {(item) => (
                      <li class="file-row">
                        <span class="file-thumb" />
                        <span class="file-name" title={item.name}>
                          {item.name}
                        </span>
                        <span class="file-size">
                          {humanSize(item.size)}
                          {item.kind === 'pdf' && item.pageCount > 0
                            ? ` · ${item.pageCount} ${item.pageCount === 1 ? 'page' : 'pages'}`
                            : item.kind === 'image'
                              ? ' · image'
                              : ''}
                          <Show when={item.thumbError}>
                            <span class="file-warn" role="note">
                              {' '}
                              · {item.thumbError}
                            </span>
                          </Show>
                        </span>
                        <span class="file-actions">
                          <button
                            type="button"
                            class="btn btn-sm btn-icon btn-ghost"
                            aria-label={`Move ${item.name} up`}
                            onClick={() => moveFile(item.id, -1)}
                            disabled={phase() !== 'ready'}
                          >
                            <ArrowUpIcon />
                          </button>
                          <button
                            type="button"
                            class="btn btn-sm btn-icon btn-ghost"
                            aria-label={`Move ${item.name} down`}
                            onClick={() => moveFile(item.id, 1)}
                            disabled={phase() !== 'ready'}
                          >
                            <ArrowDownIcon />
                          </button>
                          <button
                            type="button"
                            class="btn btn-sm btn-icon btn-ghost"
                            aria-label={`Remove ${item.name}`}
                            onClick={() => remove(item.id)}
                            disabled={phase() !== 'ready'}
                          >
                            <TrashIcon />
                          </button>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>

                <Show when={seq().length > 0 || loadingFiles()}>
                  <div class="seq-wrap">
                    <p class="seq-head">
                      Page order
                      <span class="seq-count">
                        {pageTotal()} {pageTotal() === 1 ? 'page' : 'pages'}
                      </span>
                    </p>
                    <ul
                      class="page-strip"
                      aria-label="Page order — drag a tile or use the arrow buttons to reorder"
                      onDragOver={(e) => {
                        e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const src = e.dataTransfer?.getData('text/plain') || dragId();
                        if (src) moveSeq(src, null);
                        setDragId('');
                        setDragOverId('');
                      }}
                    >
                      <For each={seq()}>
                        {(s) => {
                          const it = () => itemOf(s.file);
                          const thumb = () => it()?.thumbUrl ?? it()?.thumbs[s.page - 1] ?? '';
                          return (
                            <li
                              class="seq-tile"
                              data-seq-id={s.id}
                              draggable={phase() === 'ready'}
                              onDragStart={(e) => {
                                e.dataTransfer?.setData('text/plain', s.id);
                                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                                setDragId(s.id);
                              }}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setDragOverId(s.id);
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const src = e.dataTransfer?.getData('text/plain') || dragId();
                                if (src && src !== s.id) moveSeq(src, s.id);
                                setDragId('');
                                setDragOverId('');
                              }}
                              onDragEnd={() => {
                                setDragId('');
                                setDragOverId('');
                              }}
                              classList={{
                                'drag-over': dragOverId() === s.id && dragId() !== s.id,
                                dragging: dragId() === s.id,
                              }}
                            >
                              {thumb() ? (
                                <img
                                  class="seq-thumb"
                                  src={thumb()}
                                  alt=""
                                  loading="lazy"
                                  draggable={false}
                                />
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
                                  onClick={() => movePage(s.id, -1)}
                                  disabled={phase() !== 'ready'}
                                >
                                  ‹
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Move page ${s.page} of ${it()?.name} right`}
                                  onClick={() => movePage(s.id, 1)}
                                  disabled={phase() !== 'ready'}
                                >
                                  ›
                                </button>
                              </span>
                            </li>
                          );
                        }}
                      </For>
                      <Show when={loadingFiles()}>
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
              </Show>
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
