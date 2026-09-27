/**
 * Combine pages (n-up) tool page.
 *
 * Single PDF in → selectable page subset + per-sheet grid (2-up…16-up).
 * The n selected pages flow onto m = ceil(n / cells) sheets.
 */

import { Meta, Title } from '@solidjs/meta';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { AdSlot } from '~/components/AdSlot';
import { AlertIcon, CheckIcon, DownloadIcon, SpinnerIcon, TrashIcon } from '~/components/Icons';
import { DropZone, ProgressBar, ToolColumns, ToolPage } from '~/components/Shell';
import { type CombineOptions, combinePages, GRIDS, sheetCount } from '~/features/pdf-combine/logic';
import { saveBlob } from '~/lib/download';
import { cleanFileName, humanSize, readFileBytes } from '~/lib/files';
import { renderPageThumbs } from '~/lib/thumbs';
import { type FileItem, isPdfFile, type ProgressFn } from '~/lib/types';
import { expandAds } from '~/site/ads';
import { siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

type Phase = 'empty' | 'ready' | 'processing' | 'done';

type SheetSize = 'a4' | 'letter';
type Orientation = 'portrait' | 'landscape';
type DpiChoice = 100 | 150 | 200;

/** Sheet sizes in PDF points (portrait). */
const SHEET_SIZES: Record<SheetSize, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

export default function CombinePage() {
  const meta = routeMeta['/pdf-combine']!;

  const [file, setFile] = createSignal<FileItem | null>(null);
  const [pageCount, setPageCount] = createSignal(0);
  /** JPEG data URLs for page previews (page 1 first; may be capped). */
  const [thumbs, setThumbs] = createSignal<string[]>([]);
  /** 1-based page numbers, in ascending order. */
  const [selected, setSelected] = createSignal<number[]>([]);
  const [phase, setPhase] = createSignal<Phase>('empty');
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal({ done: 0, total: 1, label: '' });
  const [result, setResult] = createSignal<{
    bytes: Uint8Array;
    name: string;
    sheets: number;
  } | null>(null);

  const [gridId, setGridId] = createSignal('4');
  const [sheetSize, setSheetSize] = createSignal<SheetSize>('a4');
  const [orientation, setOrientation] = createSignal<Orientation>('portrait');
  const [dpi, setDpi] = createSignal<DpiChoice>(150);

  const grid = () => GRIDS.find((g) => g.id === gridId()) ?? GRIDS[1]!;

  const sheetDims = (): [number, number] => {
    const [w, h] = SHEET_SIZES[sheetSize()];
    return orientation() === 'landscape' ? [h, w] : [w, h];
  };

  const selectedCount = () => selected().length;

  const preview = createMemo(() => {
    const n = selectedCount();
    if (n === 0 || pageCount() === 0) return '';
    const m = sheetCount(n, grid().cols * grid().rows);
    return `${n} ${n === 1 ? 'page' : 'pages'} · ${grid().label} → ${m} ${m === 1 ? 'sheet' : 'sheets'}`;
  });

  const pickFile = async (files: File[]) => {
    const candidate = files[0];
    if (!candidate) return;
    if (!isPdfFile(candidate)) {
      setError(`"${cleanFileName(candidate.name)}" is not a PDF.`);
      return;
    }
    setError('');
    setResult(null);
    expandAds();
    setPhase('processing');
    setProgress({ done: 0, total: 1, label: 'Opening PDF…' });
    try {
      const bytes = await readFileBytes(candidate);
      const r = await renderPageThumbs(new Uint8Array(bytes), 110, 200);
      if (r.error) throw new Error(r.error);
      const count = r.count;
      setThumbs(r.thumbs);
      setPageCount(count);
      setSelected(Array.from({ length: count }, (_, i) => i + 1)); // select all by default
      setFile({
        id: 'pdf',
        name: cleanFileName(candidate.name),
        size: candidate.size,
        type: candidate.type,
        file: candidate,
      });
      setPhase('ready');
    } catch (err) {
      setPhase('empty');
      setError(err instanceof Error ? err.message : 'Could not open this PDF.');
    }
  };

  const clear = () => {
    setFile(null);
    setPageCount(0);
    setThumbs([]);
    setSelected([]);
    setPhase('empty');
    setResult(null);
    setError('');
  };

  const togglePage = (n: number) => {
    setSelected((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b),
    );
    setResult(null);
  };

  const process = async () => {
    const f = file();
    const pages = selected();
    expandAds();
    if (!f || pages.length === 0 || phase() === 'processing') return;
    setPhase('processing');
    setError('');
    setResult(null);
    setProgress({ done: 0, total: 1, label: 'Starting…' });
    try {
      const data = await readFileBytes(f.file);
      const [sheetW, sheetH] = sheetDims();
      const options: CombineOptions = {
        cols: grid().cols,
        rows: grid().rows,
        sheetW,
        sheetH,
        dpi: dpi(),
      };
      const onProgress: ProgressFn = (done, total, label) =>
        setProgress({ done, total, label: label ?? '' });
      const bytes = await combinePages(data, pages, options, onProgress);
      const sheets = sheetCount(pages.length, grid().cols * grid().rows);
      const resultName = `${f.name.replace(/\.pdf$/i, '') || 'document'}-combined.pdf`;
      setResult({ bytes, name: resultName, sheets });
      setPhase('done');
      saveBlob(bytes, resultName, 'application/pdf'); // auto-download
    } catch (err) {
      setPhase('ready');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const download = () => {
    const r = result();
    if (r) saveBlob(r.bytes, r.name, 'application/pdf');
  };

  return (
    <>
      <Title>{meta.title}</Title>
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/pdf-combine`} />
      {meta.image && <Meta property="og:image" content={meta.image} />}
      <script type="application/ld+json" innerHTML={JSON.stringify(jsonLdFor('/pdf-combine'))} />

      <ToolPage
        title="Combine pages"
        lede="Fit several pages of a PDF onto a single sheet. Pick 2-up, 4-up, 9-up or 16-up and the selected pages flow onto as many sheets as needed — all in your browser."
        related={[
          { path: '/pdf-to-image', label: 'PDF to image' },
          { path: '/pdf-merge', label: 'Merge PDF' },
          { path: '/pdf-compress', label: 'Compress PDF' },
        ]}
      >
        <ToolColumns
          aside={
            <>
              <div class="panel">
                <div class="panel-body">
                  <div class="opt-group">
                    <label for="grid">Layout per sheet</label>
                    <select
                      id="grid"
                      value={gridId()}
                      onChange={(e) => setGridId(e.currentTarget.value)}
                    >
                      {GRIDS.map((g) => (
                        <option value={g.id}>{g.label}</option>
                      ))}
                    </select>
                  </div>
                  <div class="opt-group">
                    <label for="sheetSize">Sheet size</label>
                    <select
                      id="sheetSize"
                      value={sheetSize()}
                      onChange={(e) => setSheetSize(e.currentTarget.value as SheetSize)}
                    >
                      <option value="a4">A4</option>
                      <option value="letter">Letter</option>
                    </select>
                  </div>
                  <div class="opt-group">
                    <label for="orientation">Orientation</label>
                    <select
                      id="orientation"
                      value={orientation()}
                      onChange={(e) => setOrientation(e.currentTarget.value as Orientation)}
                    >
                      <option value="portrait">Portrait</option>
                      <option value="landscape">Landscape</option>
                    </select>
                  </div>
                  <div class="opt-group">
                    <label for="cdpi">Resolution</label>
                    <select
                      id="cdpi"
                      value={dpi()}
                      onChange={(e) => setDpi(Number(e.currentTarget.value) as DpiChoice)}
                    >
                      <option value={100}>100 DPI — lightweight</option>
                      <option value={150}>150 DPI — documents</option>
                      <option value={200}>200 DPI — crisp</option>
                    </select>
                    <p class="opt-hint">
                      {sheetSize() === 'a4' ? 'A4' : 'Letter'} · {orientation()} ·{' '}
                      {sheetSize() === 'a4' ? '595 × 842' : '612 × 792'} pt
                    </p>
                  </div>
                </div>
              </div>
              <div class="panel">
                <div class="panel-body">
                  <h3>Good to know</h3>
                  <p style="font-size: 0.88rem; color: var(--ink-muted); margin: 0">
                    Pages are placed at high resolution, so combined sheets are image-based.
                    Deselect pages you don't need — the rest flow onto as many sheets as required.
                  </p>
                </div>
              </div>
              <AdSlot slot="tool-bottom" className="aside-ad" />
            </>
          }
        >
          <div class="panel">
            <div class="panel-body">
              <Show when={!file() || phase() === 'empty'}>
                <DropZone
                  accept="application/pdf,.pdf"
                  title="Drop a PDF here"
                  subtitle="pick pages, choose a layout, combine"
                  busy={phase() === 'processing'}
                  onFiles={pickFile}
                />
              </Show>
              <Show when={file()}>
                <div class="file-row" style="margin-bottom: 0.5rem">
                  <span class="file-name" title={file()!.name}>
                    {file()!.name}
                  </span>
                  <span class="file-size">
                    {humanSize(file()!.size)}
                    {pageCount() > 0 ? ` · ${pageCount()} pages` : ''}
                  </span>
                  <span class="file-actions">
                    <button
                      type="button"
                      class="btn btn-sm btn-icon btn-ghost"
                      aria-label="Remove PDF"
                      onClick={clear}
                    >
                      <TrashIcon />
                    </button>
                  </span>
                </div>
              </Show>

              <Show when={file() && pageCount() > 0}>
                <div style="display: flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0">
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    onClick={() =>
                      setSelected(Array.from({ length: pageCount() }, (_, i) => i + 1))
                    }
                  >
                    <CheckIcon /> All
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    onClick={() => setSelected([])}
                  >
                    None
                  </button>
                  <span style="font-size: 0.85rem; color: var(--ink-muted); margin-left: auto">
                    {selectedCount()} selected
                  </span>
                </div>
                <fieldset class="page-grid" aria-label="Select pages to combine">
                  <For each={Array.from({ length: pageCount() }, (_, i) => i + 1)}>
                    {(n) => (
                      <button
                        type="button"
                        class="page-tile"
                        aria-pressed={selected().includes(n)}
                        onClick={() => togglePage(n)}
                        disabled={phase() !== 'ready'}
                      >
                        <Show when={thumbs()[n - 1]}>
                          <img
                            class="page-tile-img"
                            src={thumbs()[n - 1]!}
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
              <Show when={error()}>
                <div class="error-card" role="alert">
                  <AlertIcon />
                  <span>{error()}</span>
                </div>
              </Show>
            </div>
          </div>

          <Show when={file() && phase() === 'ready'}>
            <div class="panel cta">
              <div class="panel-body">
                <Show when={preview()}>
                  <p class="opt-hint" style="text-align: center; margin: 0 0 0.6rem">
                    {preview()}
                  </p>
                </Show>
                <button
                  type="button"
                  class="btn btn-primary btn-block"
                  onClick={process}
                  disabled={selectedCount() === 0}
                >
                  <SpinnerIcon />
                  Combine {selectedCount() || 'selected'} {selectedCount() === 1 ? 'page' : 'pages'}
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
                  <span class="now">
                    {result()!.sheets} {result()!.sheets === 1 ? 'sheet' : 'sheets'}
                  </span>
                  <span class="delta neutral">{humanSize(result()!.bytes.byteLength)}</span>
                </div>
                <div class="result-actions">
                  <button type="button" class="btn btn-primary" onClick={download}>
                    <DownloadIcon />
                    Download PDF
                  </button>
                  <button type="button" class="btn btn-ghost" onClick={() => setPhase('ready')}>
                    Adjust and combine again
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
