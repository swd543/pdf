/**
 * Combine pages (n-up) tool page.
 *
 * Single PDF in → selectable page subset + per-sheet grid (2-up…16-up).
 * The n selected pages flow onto m = ceil(n / cells) sheets.
 */

import { Meta, Title } from '@solidjs/meta';
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { AdSlot } from '~/components/AdSlot';
import { Canonical } from '~/components/Canonical';
import { AlertIcon, DownloadIcon, SpinnerIcon } from '~/components/Icons';
import { ProgressBar, ToolColumns, ToolPage } from '~/components/Shell';
import { SinglePdfInput } from '~/components/SinglePdfInput';
import { type CombineOptions, combinePages, GRIDS, sheetCount } from '~/features/pdf-combine/logic';
import { PagePicker } from '~/features/pdf-combine/PagePicker';
import { CombinePreviewSession } from '~/features/pdf-combine/preview-session';
import { SheetPreview } from '~/features/pdf-combine/SheetPreview';
import { useChainedPdf } from '~/lib/chain';
import { saveBlob } from '~/lib/download';
import { cleanFileName, humanSize, readFileBytes } from '~/lib/files';
import { MAX_INTERACTIVE_PAGES, MAX_PAGE_THUMBNAILS } from '~/lib/limits';
import { createOperation, isAbortError, type OperationHandle } from '~/lib/operation';
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

  // Pick up a result chained from another tool ("Continue with …").
  // Lambda: `pickFile` is defined below; the hook invokes it in onMount.
  const chain = useChainedPdf((f) => pickFile([f]));

  /** One open PDF document shared by thumbnails + live previews (P1.1). */
  let session: CombinePreviewSession | null = null;
  /** Cancellation for the in-flight final combine (P1.6). */
  let opHandle: OperationHandle | null = null;
  onCleanup(() => {
    opHandle?.cancel();
    void session?.dispose();
  });

  /** Debounce: rapid toggling must not queue a render per change (P1.1). */
  const PREVIEW_DEBOUNCE_MS = 160;
  let previewTimer: number | null = null;
  let previewGen = 0;

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

  /** Live preview of the combined sheets (auto-updates on every change to
   *  the selection or layout options). Debounced; superseded renders are
   *  cancelled inside the session. */
  const [sheetPrev, setSheetPrev] = createSignal<{ urls: string[]; total: number }>({
    urls: [],
    total: 0,
  });

  createEffect(() => {
    // Reading these inside the effect makes it re-run when any changes.
    const s = session;
    const pages = [...selected()];
    const g = grid();
    const [sheetW, sheetH] = sheetDims();
    const ready = phase() === 'ready' && pageCount() > 0;

    if (previewTimer !== null) {
      window.clearTimeout(previewTimer);
      previewTimer = null;
    }
    if (!s || pages.length === 0 || !ready) {
      setSheetPrev({ urls: [], total: 0 });
      return;
    }
    const gen = ++previewGen;
    previewTimer = window.setTimeout(() => {
      previewTimer = null;
      void (async () => {
        try {
          const r = await s.previewSheets(pages, { cols: g.cols, rows: g.rows, sheetW, sheetH });
          if (gen === previewGen) setSheetPrev(r);
        } catch (err) {
          // Superseded/cancelled previews are expected; real failures hide.
          if (!isAbortError(err) && gen === previewGen) setSheetPrev({ urls: [], total: 0 });
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
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
    const old = session;
    const fresh = new CombinePreviewSession();
    try {
      const raw = new Uint8Array(await readFileBytes(candidate));
      const count = await fresh.open(raw.slice()); // pdfjs detaches its input
      if (count === 0) throw new Error('This PDF has no pages');
      if (count > MAX_INTERACTIVE_PAGES) {
        throw new Error(
          `This PDF has ${count} pages; the page picker supports ${MAX_INTERACTIVE_PAGES} at a time.`,
        );
      }
      session = fresh;
      await old?.dispose();
      const thumbs = await fresh.thumbs(110, MAX_PAGE_THUMBNAILS);
      // File may have been cleared/replaced while opening.
      if (session !== fresh) return;
      setThumbs(thumbs);
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
      session = null;
      await fresh.dispose();
      await old?.dispose();
      setPhase('empty');
      setError(err instanceof Error ? err.message : 'Could not open this PDF.');
    }
  };

  const clear = () => {
    const s = session;
    session = null;
    void s?.dispose();
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
    const onProgress: ProgressFn = (done, total, label) =>
      setProgress({ done, total, label: label ?? '' });
    const handle = createOperation(onProgress);
    opHandle = handle;
    try {
      // The final output re-reads the File — no extra raw-byte copy is kept
      // in memory just to avoid this (handoff P1.1 note 7).
      const data = await readFileBytes(f.file);
      const [sheetW, sheetH] = sheetDims();
      const options: CombineOptions = {
        cols: grid().cols,
        rows: grid().rows,
        sheetW,
        sheetH,
        dpi: dpi(),
        op: handle.op,
      };
      const bytes = await combinePages(data, pages, options, onProgress);
      const sheets = sheetCount(pages.length, grid().cols * grid().rows);
      const resultName = `${f.name.replace(/\.pdf$/i, '') || 'document'}-combined.pdf`;
      setResult({ bytes, name: resultName, sheets });
      setPhase('done');
    } catch (err) {
      if (isAbortError(err)) {
        setPhase('ready');
        setProgress({ done: 0, total: 1, label: '' });
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

  return (
    <>
      <Title>{meta.title}</Title>
      <Canonical path="/pdf-combine" />
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/pdf-combine/`} />
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
              <SinglePdfInput
                file={file}
                pageCount={pageCount}
                showDrop={() => !file() || phase() === 'empty'}
                dropTitle="Drop a PDF here"
                dropSubtitle="pick pages, choose a layout, combine"
                busy={phase() === 'processing'}
                note={chain.note}
                dismissNote={chain.dismissNote}
                onFiles={pickFile}
                onClear={clear}
              />

              <PagePicker
                visible={() => Boolean(file() && pageCount() > 0)}
                pageCount={pageCount}
                thumbs={thumbs}
                selected={selected}
                selectedCount={selectedCount}
                onToggle={togglePage}
                onSelectAll={() =>
                  setSelected(Array.from({ length: pageCount() }, (_, i) => i + 1))
                }
                onSelectNone={() => setSelected([])}
                disabled={() => phase() !== 'ready'}
              />

              <SheetPreview
                visible={() => phase() === 'ready' && selectedCount() > 0 && sheetPrev().total > 0}
                preview={sheetPrev}
              />
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
