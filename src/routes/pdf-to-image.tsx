/**
 * PDF → Image tool page.
 *
 * Single PDF in; PNG/JPEG/WebP out (one file or a ZIP). Page count is fetched
 * up-front (cheap parse) so the range inputs are usable.
 */

import { Meta, Title } from '@solidjs/meta';
import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { AdSlot } from '~/components/AdSlot';
import { AlertIcon, DownloadIcon, SpinnerIcon } from '~/components/Icons';
import { ProgressBar, ToolColumns, ToolPage } from '~/components/Shell';
import { SinglePdfInput } from '~/components/SinglePdfInput';
import {
  type DpiOption,
  type ExportFormat,
  forEachPdfImage,
  pageFileName,
  pdfToImages,
  resolveRange,
} from '~/features/pdf-to-image/logic';
import { useChainedPdf } from '~/lib/chain';
import { saveBlob } from '~/lib/download';
import { cleanFileName, humanSize, readFileBytes } from '~/lib/files';
import { createOperation, isAbortError, type OperationHandle } from '~/lib/operation';
import { disposePdf, pdfDocument } from '~/lib/pdfjs';
import { type FileItem, isPdfFile, type ProgressFn } from '~/lib/types';
import { ZipStream } from '~/lib/zip';
import { expandAds } from '~/site/ads';
import { siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

type Phase = 'empty' | 'ready' | 'processing' | 'done';

const FORMAT_LABEL: Record<ExportFormat, string> = {
  png: 'PNG (lossless)',
  jpeg: 'JPEG',
  webp: 'WebP',
};

export default function PdfToImagePage() {
  const meta = routeMeta['/pdf-to-image']!;

  const [file, setFile] = createSignal<FileItem | null>(null);
  const [pageCount, setPageCount] = createSignal(0);
  const [phase, setPhase] = createSignal<Phase>('empty');
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal({ done: 0, total: 1, label: '' });
  const [result, setResult] = createSignal<{
    bytes: Uint8Array;
    name: string;
    pages: number;
  } | null>(null);

  const [format, setFormat] = createSignal<ExportFormat>('png');
  const [quality, setQuality] = createSignal(0.9);
  const [dpi, setDpi] = createSignal<DpiOption>(150);
  const [from, setFrom] = createSignal('');
  const [to, setTo] = createSignal('');

  // Pick up a result chained from another tool ("Continue with …").
  const chain = useChainedPdf((f) => pickFile([f]));

  /** Cancellation for the in-flight export (P1.6). */
  let opHandle: OperationHandle | null = null;
  onCleanup(() => opHandle?.cancel());

  const hasLossy = () => format() !== 'png';

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
      const pdf = await pdfDocument(new Uint8Array(bytes));
      const count = pdf.numPages;
      disposePdf(pdf);
      setPageCount(count);
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
    opHandle?.cancel();
    opHandle = null;
    setFile(null);
    setPageCount(0);
    setPhase('empty');
    setResult(null);
    setError('');
    setFrom('');
    setTo('');
  };

  const process = async () => {
    const f = file();
    expandAds();
    if (!f || phase() === 'processing') return;
    setPhase('processing');
    setError('');
    setResult(null);

    const onProgress: ProgressFn = (done, total, label) =>
      setProgress({ done, total, label: label ?? '' });
    const handle = createOperation(onProgress);
    opHandle = handle;
    try {
      const data = await readFileBytes(f.file);
      const options = {
        format: format(),
        quality: hasLossy() ? quality() : 0.9,
        dpi: dpi(),
        from: from() === '' ? undefined : Number(from()),
        to: to() === '' ? undefined : Number(to()),
        op: handle.op,
      };
      if (
        (options.from === undefined || Number.isInteger(options.from)) === false ||
        (options.to !== undefined && options.to < (options.from ?? 1))
      ) {
        throw new Error('Invalid page range');
      }

      const base = f.name;
      const { first, last } = resolveRange(options.from, options.to, pageCount());

      if (last <= first) {
        const images = await pdfToImages(data, options, onProgress);
        if (images.length === 0) throw new Error('Nothing was exported — check the page range.');
        const img = images[0]!;
        setResult({
          bytes: img.bytes,
          name: pageFileName(base, img.page, img.ext, false),
          pages: 1,
        });
        setPhase('done');
        return;
      }

      // Multi-page: stream each rendered page straight into the ZIP so the
      // tool never holds every page image at once (handoff P0.5).
      const zip = new ZipStream();
      let count = 0;
      await forEachPdfImage(
        data,
        options,
        (img) => {
          zip.add(pageFileName(base, img.page, img.ext, true), img.bytes);
          count += 1;
        },
        onProgress,
      );
      const out = await zip.finish();
      if (count === 0) throw new Error('Nothing was exported — check the page range.');
      setResult({
        bytes: out,
        name: `${base.replace(/\.pdf$/i, '') || 'document'}-pages.zip`,
        pages: count,
      });
      setPhase('done');
    } catch (err) {
      if (isAbortError(err)) {
        // Cancellation is not a failure — return to a clean ready state.
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
    if (!r) return;
    saveBlob(r.bytes, r.name, r.name.endsWith('.zip') ? 'application/zip' : undefined);
  };

  const rangePreview = createMemo(() => {
    if (pageCount() === 0) return '';
    const { first, last } = resolveRange(
      from() === '' ? undefined : Number(from()),
      to() === '' ? undefined : Number(to()),
      pageCount(),
    );
    return first === last ? `page ${first}` : `pages ${first}–${last} (${last - first + 1})`;
  });

  return (
    <>
      <Title>{meta.title}</Title>
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/pdf-to-image`} />
      {meta.image && <Meta property="og:image" content={meta.image} />}
      <script type="application/ld+json" innerHTML={JSON.stringify(jsonLdFor('/pdf-to-image'))} />

      <ToolPage
        title="PDF to Image"
        lede="Export PDF pages as PNG, JPEG or WebP. Pick the resolution, export one page or all pages as a ZIP — rendered locally by Mozilla PDF.js."
        related={[
          { path: '/image-to-pdf', label: 'Image to PDF' },
          { path: '/pdf-compress', label: 'Compress PDF' },
          { path: '/pdf-sign', label: 'Sign & fill' },
        ]}
      >
        <ToolColumns
          aside={
            <>
              <div class="panel">
                <div class="panel-body">
                  <div class="opt-group">
                    <label for="fmt">Format</label>
                    <select
                      id="fmt"
                      value={format()}
                      onChange={(e) => setFormat(e.currentTarget.value as ExportFormat)}
                    >
                      {(Object.keys(FORMAT_LABEL) as ExportFormat[]).map((f) => (
                        <option value={f}>{FORMAT_LABEL[f]}</option>
                      ))}
                    </select>
                  </div>
                  <Show when={hasLossy()}>
                    <div class="opt-group">
                      <label for="qual">Quality</label>
                      <div class="range-row">
                        <input
                          id="qual"
                          type="range"
                          min={40}
                          max={95}
                          step={1}
                          value={quality() * 100}
                          onChange={(e) => setQuality(Number(e.currentTarget.value) / 100)}
                        />
                        <output>{Math.round(quality() * 100)}</output>
                      </div>
                    </div>
                  </Show>
                  <div class="opt-group">
                    <label for="dpi">Resolution</label>
                    <select
                      id="dpi"
                      value={dpi()}
                      onChange={(e) => setDpi(Number(e.currentTarget.value) as DpiOption)}
                    >
                      <option value={96}>96 DPI — screen</option>
                      <option value={150}>150 DPI — documents</option>
                      <option value={220}>220 DPI — crisp</option>
                      <option value={300}>300 DPI — print</option>
                    </select>
                  </div>
                  <div class="opt-group">
                    <span class="opt-label">Pages</span>
                    <div style="display: flex; gap: 0.5rem">
                      <input
                        type="number"
                        min={1}
                        placeholder="From"
                        value={from()}
                        onInput={(e) => setFrom(e.currentTarget.value)}
                        aria-label="First page"
                      />
                      <input
                        type="number"
                        min={1}
                        placeholder={pageCount() ? String(pageCount()) : 'To'}
                        value={to()}
                        onInput={(e) => setTo(e.currentTarget.value)}
                        aria-label="Last page"
                      />
                    </div>
                    <Show when={rangePreview()}>
                      <p class="opt-hint" style="margin-top: 0.4rem">
                        {rangePreview()}
                      </p>
                    </Show>
                  </div>
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
                dropSubtitle="any size, any page count"
                busy={phase() === 'processing'}
                note={chain.note}
                dismissNote={chain.dismissNote}
                onFiles={pickFile}
                onClear={clear}
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
                <button type="button" class="btn btn-primary btn-block" onClick={process}>
                  <SpinnerIcon />
                  Convert {rangePreview() || 'all pages'} to {FORMAT_LABEL[format()]}
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
                    {result()!.pages} {result()!.pages === 1 ? 'image' : 'images'}
                  </span>
                  <span class="delta neutral">{humanSize(result()!.bytes.byteLength)}</span>
                </div>
                <div class="result-actions">
                  <button type="button" class="btn btn-primary" onClick={download}>
                    <DownloadIcon />
                    {result()!.pages === 1 ? 'Download image' : 'Download ZIP'}
                  </button>
                  <button type="button" class="btn btn-ghost" onClick={() => setPhase('ready')}>
                    Convert again
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
