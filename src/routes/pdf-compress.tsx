/**
 * Compress PDF tool page.
 *
 * Two modes (see `./logic`):
 *  - lossless: Rust/WASM structural re-save (or pdf-lib fallback)
 *  - strong:   re-render pages to JPEG and rebuild
 */

import { Meta, Title } from '@solidjs/meta';
import { createSignal, Show } from 'solid-js';
import { AdSlot } from '~/components/AdSlot';
import { AlertIcon, DownloadIcon, SpinnerIcon, TrashIcon } from '~/components/Icons';
import { DropZone, ProgressBar, ToolColumns, ToolPage } from '~/components/Shell';
import {
  type CompressMode,
  type CompressOutcome,
  compressPdf,
} from '~/features/pdf-compress/logic';
import type { DpiOption } from '~/features/pdf-to-image/logic';
import { saveBlob } from '~/lib/download';
import { cleanFileName, humanSize, percentSaved, readFileBytes } from '~/lib/files';
import { type FileItem, isPdfFile, type ProgressFn } from '~/lib/types';
import { expandAds } from '~/site/ads';
import { siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

type Phase = 'empty' | 'ready' | 'processing' | 'done';

export default function PdfCompressPage() {
  const meta = routeMeta['/pdf-compress']!;

  const [file, setFile] = createSignal<FileItem | null>(null);
  const [phase, setPhase] = createSignal<Phase>('empty');
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal({ done: 0, total: 1, label: '' });
  const [result, setResult] = createSignal<(CompressOutcome & { name: string }) | null>(null);

  const [mode, setMode] = createSignal<CompressMode>('lossless');
  const [quality, setQuality] = createSignal(78);
  const [dpi, setDpi] = createSignal(150);

  const pickFile = (files: File[]) => {
    const candidate = files[0];
    if (!candidate) return;
    if (!isPdfFile(candidate)) {
      setError(`"${cleanFileName(candidate.name)}" is not a PDF.`);
      return;
    }
    setError('');
    setResult(null);
    setFile({
      id: 'pdf',
      name: cleanFileName(candidate.name),
      size: candidate.size,
      type: candidate.type,
      file: candidate,
    });
    setPhase('ready');
  };

  const clear = () => {
    setFile(null);
    setPhase('empty');
    setResult(null);
    setError('');
  };

  const process = async () => {
    const f = file();
    if (!f || phase() === 'processing') return;
    expandAds();
    setPhase('processing');
    setError('');
    setResult(null);
    try {
      const data = await readFileBytes(f.file);
      const onProgress: ProgressFn = (done, total, label) =>
        setProgress({ done, total, label: label ?? '' });
      const outcome = await compressPdf(
        data,
        {
          mode: mode(),
          quality: quality() / 100,
          dpi: dpi() as DpiOption,
        },
        onProgress,
      );
      const name = `${f.name.replace(/\.pdf$/i, '') || 'document'}-compressed.pdf`;
      setResult({ ...outcome, name });
      setPhase('done');
      saveBlob(outcome.bytes, name, 'application/pdf'); // auto-download
    } catch (err) {
      setPhase('ready');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const download = () => {
    const r = result();
    if (r) saveBlob(r.bytes, r.name, 'application/pdf');
  };

  const saved = () => {
    const r = result();
    const f = file();
    if (!r || !f) return 0;
    return percentSaved(f.size, r.bytes.byteLength);
  };

  const viaLabel = () => {
    const v = result()?.via;
    if (v === 'wasm') return 'Rust/WASM core';
    if (v === 'js-fallback') return 'JS fallback';
    return 're-encoded';
  };

  return (
    <>
      <Title>{meta.title}</Title>
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/pdf-compress`} />
      {meta.image && <Meta property="og:image" content={meta.image} />}
      <script type="application/ld+json" innerHTML={JSON.stringify(jsonLdFor('/pdf-compress'))} />

      <ToolPage
        title="Compress PDF"
        lede="Shrink a PDF without uploading it. Lossless mode optimizes the file's internal structure; strong mode re-renders pages for maximum size reduction."
        related={[
          { path: '/image-to-pdf', label: 'Image to PDF' },
          { path: '/pdf-to-image', label: 'PDF to image' },
          { path: '/pdf-sign', label: 'Sign & fill' },
        ]}
      >
        <ToolColumns
          aside={
            <>
              <div class="panel">
                <div class="panel-body">
                  <div class="opt-group">
                    <span class="opt-label">Mode</span>
                    <label class="toggle" style="margin-bottom: 0.6rem">
                      <input
                        type="checkbox"
                        checked={mode() === 'strong'}
                        onChange={(e) => setMode(e.currentTarget.checked ? 'strong' : 'lossless')}
                        disabled={phase() === 'processing'}
                      />
                      <span class="knob" />
                      <span>Strong compression</span>
                    </label>
                    <p class="opt-hint" style="margin: 0">
                      {mode() === 'lossless'
                        ? 'Lossless: structure-only optimization. Quality cannot change; best for already-clean PDFs.'
                        : 'Strong: pages are re-rendered as images. Bigger savings, but text becomes non-selectable.'}
                    </p>
                  </div>
                  <Show when={mode() === 'strong'}>
                    <div class="opt-group">
                      <label for="cqual">Image quality</label>
                      <div class="range-row">
                        <input
                          id="cqual"
                          type="range"
                          min={40}
                          max={90}
                          step={1}
                          value={quality()}
                          onChange={(e) => setQuality(Number(e.currentTarget.value))}
                        />
                        <output>{quality()}</output>
                      </div>
                    </div>
                    <div class="opt-group">
                      <label for="cdpi">Resolution</label>
                      <select
                        id="cdpi"
                        value={dpi()}
                        onChange={(e) => setDpi(Number(e.currentTarget.value))}
                      >
                        <option value={96}>96 DPI — smallest</option>
                        <option value={150}>150 DPI — balanced</option>
                        <option value={220}>220 DPI — crisp</option>
                      </select>
                    </div>
                  </Show>
                </div>
              </div>
              <div class="panel">
                <div class="panel-body">
                  <h3>Honest compression</h3>
                  <p style="font-size: 0.88rem; color: var(--ink-muted); margin: 0">
                    No secret re-encoding of your text, no watermarks, no “pro” tier. If a mode
                    can't make your file smaller, we'll tell you instead of pretending.
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
                  subtitle="compressed entirely on your device"
                  busy={phase() === 'processing'}
                  onFiles={pickFile}
                />
              </Show>
              <Show when={file()}>
                <div class="file-row" style="margin-bottom: 0.5rem">
                  <span class="file-name" title={file()!.name}>
                    {file()!.name}
                  </span>
                  <span class="file-size">{humanSize(file()!.size)}</span>
                  <span class="file-actions">
                    <button
                      type="button"
                      class="btn btn-sm btn-icon btn-ghost"
                      aria-label="Remove PDF"
                      onClick={clear}
                      disabled={phase() === 'processing'}
                    >
                      <TrashIcon />
                    </button>
                  </span>
                </div>
              </Show>
              <Show when={error()}>
                <div class="error-card" role="alert">
                  <AlertIcon />
                  <span>{error()}</span>
                </div>
              </Show>
            </div>
          </div>

          <Show when={file() && phase() !== 'processing' && phase() !== 'done'}>
            <div class="panel cta">
              <div class="panel-body">
                <button type="button" class="btn btn-primary btn-block" onClick={process}>
                  <SpinnerIcon />
                  {mode() === 'lossless' ? 'Compress (lossless)' : 'Compress (strong)'}
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

          <Show when={phase() === 'done' && result() && file()}>
            <div class="panel">
              <div class="result-card">
                <div class="result-size">
                  <span class="was">{humanSize(file()!.size)}</span>
                  <span class="now">{humanSize(result()!.bytes.byteLength)}</span>
                  <span class={`delta ${saved() > 0 ? '' : 'neutral'}`}>
                    {saved() > 0 ? `−${saved()}%` : 'no size change'}
                  </span>
                  <span class="delta neutral">{viaLabel()}</span>
                </div>
                <div class="result-actions">
                  <button type="button" class="btn btn-primary" onClick={download}>
                    <DownloadIcon />
                    Download PDF
                  </button>
                  <button type="button" class="btn btn-ghost" onClick={() => setPhase('ready')}>
                    {mode() === 'lossless' ? 'Try strong mode' : 'Try lossless mode'}
                  </button>
                </div>
              </div>
              <Show when={saved() <= 0}>
                <div class="panel-body">
                  <p style="font-size: 0.85rem; color: var(--ink-muted); margin: 0">
                    This file is already well optimized — the compressed version is the same size or
                    larger, so keep the original.
                  </p>
                </div>
              </Show>
            </div>
          </Show>
        </ToolColumns>
      </ToolPage>
    </>
  );
}
