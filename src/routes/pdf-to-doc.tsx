/**
 * PDF → Document (DOCX/ODT) tool page.
 *
 * Extracts the PDF's text flow and rebuilds it as an editable Word or
 * OpenDocument file — entirely in the browser.
 */

import { Meta, Title } from '@solidjs/meta';
import { createSignal, onCleanup, Show } from 'solid-js';
import { AdSlot } from '~/components/AdSlot';
import { Canonical } from '~/components/Canonical';
import { AlertIcon, DownloadIcon, SpinnerIcon } from '~/components/Icons';
import { ProgressBar, ToolColumns, ToolPage } from '~/components/Shell';
import { SinglePdfInput } from '~/components/SinglePdfInput';
import { type DocConversionResult, type DocFormat, pdfToDoc } from '~/features/pdf-to-doc/logic';
import { useChainedPdf } from '~/lib/chain';
import { saveBlob } from '~/lib/download';
import { cleanFileName, humanSize, readFileBytes } from '~/lib/files';
import { createOperation, isAbortError, type OperationHandle } from '~/lib/operation';
import { type FileItem, isPdfFile, type ProgressFn } from '~/lib/types';
import { expandAds } from '~/site/ads';
import { siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

type Phase = 'empty' | 'ready' | 'processing' | 'done';

export default function PdfToDocPage() {
  const meta = routeMeta['/pdf-to-doc']!;

  const [file, setFile] = createSignal<FileItem | null>(null);
  const [phase, setPhase] = createSignal<Phase>('empty');
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal({ done: 0, total: 1, label: '' });
  const [result, setResult] = createSignal<(DocConversionResult & { name: string }) | null>(null);
  const [format, setFormat] = createSignal<DocFormat>('docx');

  // Pick up a result chained from another tool ("Continue with …").
  const chain = useChainedPdf((f) => pickFile([f]));

  /** Cancellation for the in-flight conversion (P1.6). */
  let opHandle: OperationHandle | null = null;
  onCleanup(() => opHandle?.cancel());

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
    opHandle?.cancel();
    opHandle = null;
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
    const onProgress: ProgressFn = (done, total, label) =>
      setProgress({ done, total, label: label ?? '' });
    const handle = createOperation(onProgress);
    opHandle = handle;
    try {
      const data = await readFileBytes(f.file);
      const outcome = await pdfToDoc(data, format(), onProgress, { op: handle.op });
      const base = f.name.replace(/\.pdf$/i, '') || 'document';
      setResult({ ...outcome, name: `${base}.${format()}` });
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
    if (r) saveBlob(r.bytes, r.name, r.mime);
  };

  return (
    <>
      <Title>{meta.title}</Title>
      <Canonical path="/pdf-to-doc" />
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/pdf-to-doc/`} />
      {meta.image && <Meta property="og:image" content={meta.image} />}
      <script type="application/ld+json" innerHTML={JSON.stringify(jsonLdFor('/pdf-to-doc'))} />

      <ToolPage
        title="PDF to Word / ODF"
        lede="Turn a PDF into an editable .docx (Word) or .odt (LibreOffice/OpenDocument) file. The text is extracted and rebuilt right in your browser. Nothing is uploaded."
        related={[
          { path: '/pdf-compress', label: 'Compress PDF' },
          { path: '/pdf-to-image', label: 'PDF to image' },
          { path: '/image-to-pdf', label: 'Image to PDF' },
        ]}
      >
        <ToolColumns
          aside={
            <>
              <div class="panel">
                <div class="panel-body">
                  <div class="opt-group">
                    <label for="docfmt">Output format</label>
                    <select
                      id="docfmt"
                      value={format()}
                      onChange={(e) => setFormat(e.currentTarget.value as DocFormat)}
                      disabled={phase() === 'processing'}
                    >
                      <option value="docx">.docx (Microsoft Word)</option>
                      <option value="odt">.odt (LibreOffice / OpenDocument)</option>
                    </select>
                  </div>
                </div>
              </div>
              <div class="panel">
                <div class="panel-body">
                  <h3>What is kept, what isn't</h3>
                  <ul class="opt-hint-list">
                    <li>Text in reading order, with paragraphs</li>
                    <li>Headings, bold and italic from the original</li>
                    <li>Page breaks between pages</li>
                  </ul>
                  <p class="opt-hint" style="margin: 0.5rem 0 0">
                    Tables, images and complex multi-column layouts are not reconstructed. A PDF
                    stores where glyphs are drawn, not a document model.
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
                showDrop={() => !file() || phase() === 'empty'}
                dropTitle="Drop a PDF here"
                dropSubtitle="converted to an editable document on your device"
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

          <Show when={file() && phase() !== 'processing' && phase() !== 'done'}>
            <div class="panel cta">
              <div class="panel-body">
                <button type="button" class="btn btn-primary btn-block" onClick={process}>
                  <SpinnerIcon />
                  Convert to {format() === 'docx' ? '.docx (Word)' : '.odt (ODF)'}
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
                  <span class="now">{humanSize(result()!.bytes.byteLength)}</span>
                  <span class="delta neutral">
                    {result()!.pages} page{result()!.pages === 1 ? '' : 's'} ·{' '}
                    {result()!.paragraphCount} paragraph
                    {result()!.paragraphCount === 1 ? '' : 's'}
                  </span>
                </div>
                <div class="result-actions">
                  <button type="button" class="btn btn-primary" onClick={download}>
                    <DownloadIcon />
                    Download .{result()!.ext}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onClick={() => {
                      setFormat(format() === 'docx' ? 'odt' : 'docx');
                      setPhase('ready');
                      setResult(null);
                    }}
                  >
                    Try {format() === 'docx' ? '.odt' : '.docx'} instead
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
