/**
 * Sign & Fill tool page.
 *
 * Two capabilities on one page:
 *  - fill AcroForm fields (text/checkbox/radio/dropdown)
 *  - place signatures (drawn, typed or uploaded) at any page position
 *
 * The PDF is rendered once with PDF.js; stamps are kept in display pixels
 * and converted to PDF points on download. Applying a form fill re-renders
 * the preview so the user sees exactly what will be saved.
 */

import { Meta, Title } from '@solidjs/meta';
import { createSignal, For, Show } from 'solid-js';
import { AdSlot } from '~/components/AdSlot';
import { ChainNote } from '~/components/ChainBar';
import { AlertIcon, DownloadIcon, TrashIcon } from '~/components/Icons';
import { DropZone, ProgressBar, ToolColumns, ToolPage } from '~/components/Shell';
import type { SignaturePadApi } from '~/components/SignaturePad';
import { SignaturePad } from '~/components/SignaturePad';
import {
  type FieldInfo,
  type FieldType,
  type FieldUpdate,
  type FormScan,
  fillForm,
  placeSignatures,
  scanForm,
} from '~/features/pdf-sign/logic';
import { useChainedPdf } from '~/lib/chain';
import { saveBlob } from '~/lib/download';
import { cleanFileName, humanSize, readFileBytes } from '~/lib/files';
import { canvasToPng } from '~/lib/imaging';
import { disposePdf, pdfDocument } from '~/lib/pdfjs';
import { type FileItem, isPdfFile, yieldToBrowser } from '~/lib/types';
import { expandAds } from '~/site/ads';
import { siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

type Phase = 'empty' | 'loading' | 'ready' | 'processing';
type SigTab = 'draw' | 'type' | 'upload';

interface PageMeta {
  widthPt: number;
  heightPt: number;
}

interface Signature {
  png: Uint8Array;
  dataUrl: string;
  width: number;
  height: number;
}

interface StampView {
  id: string;
  page: number; // 1-based
  x: number; // display px (top-left)
  y: number;
  w: number;
  h: number;
  png: Uint8Array;
  dataUrl: string;
}

let stampCounter = 0;
const nextStampId = () => `stamp-${++stampCounter}`;

export default function PdfSignPage() {
  const meta = routeMeta['/pdf-sign']!;

  const [file, setFile] = createSignal<FileItem | null>(null);
  const [workingBytes, setWorkingBytes] = createSignal<ArrayBuffer | Uint8Array | null>(null);
  const [pageCount, setPageCount] = createSignal(0);
  const [pageMeta, setPageMeta] = createSignal<PageMeta[]>([]);
  const [pageScale, setPageScale] = createSignal(1);

  // Pick up a result chained from another tool ("Continue with …").
  const chain = useChainedPdf((f) => pickFile([f]));
  const [phase, setPhase] = createSignal<Phase>('empty');
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal({ done: 0, total: 1, label: '' });

  const [form, setForm] = createSignal<FormScan | null>(null);
  const [fieldValues, setFieldValues] = createSignal<Record<string, string | boolean>>({});
  /** True once a form fill has been applied (lets form-only documents download). */
  const [formApplied, setFormApplied] = createSignal(false);

  const [sigTab, setSigTab] = createSignal<SigTab>('draw');
  const [typedText, setTypedText] = createSignal('');
  const [sig, setSig] = createSignal<Signature | null>(null);
  const [placing, setPlacing] = createSignal(false);
  const [stampWidth, setStampWidth] = createSignal(170);
  const [stamps, setStamps] = createSignal<StampView[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);

  // DOM refs for the rendered page canvases (keyed by 1-based page number)
  const pageCanvases = new Map<number, HTMLCanvasElement>();
  let doc: import('pdfjs-dist').PDFDocumentProxy | null = null;

  const selectedStamp = () => stamps().find((s) => s.id === selected()) ?? null;

  const fieldType = (name: string): FieldType | undefined =>
    form()?.fields.find((f) => f.name === name)?.type;

  /* ---------------- document loading ---------------- */

  const renderAllPages = async () => {
    const n = pageCount();
    if (n === 0 || !doc) return;
    for (let p = 1; p <= n; p += 1) {
      const canvas = pageCanvases.get(p);
      if (!canvas) continue;
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: pageScale() });
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      if (!canvas.getContext('2d')) continue;
      await page.render({ canvas, viewport }).promise;
      await yieldToBrowser();
    }
  };

  const openDocument = async (bytes: ArrayBuffer | Uint8Array, announce: boolean) => {
    if (doc) {
      await disposePdf(doc);
      doc = null;
    }
    // pdfjs takes ownership of the buffer it is given (it transfers the
    // ArrayBuffer to the worker, detaching the original) — hand it a copy
    // so `bytes` stays usable for the form scan and the download.
    const pdf = await pdfDocument(new Uint8Array(bytes.slice(0)));
    doc = pdf;

    const n = pdf.numPages;
    if (n === 0) throw new Error('This PDF has no pages');
    const metas: PageMeta[] = [];
    for (let p = 1; p <= n; p += 1) {
      const page = await pdf.getPage(p);
      const base = page.getViewport({ scale: 1 });
      metas.push({ widthPt: base.width, heightPt: base.height });
    }

    // Adaptive display width so big documents stay light in memory.
    const target = n <= 10 ? 560 : n <= 50 ? 420 : 300;
    const firstWidth = metas[0]?.widthPt ?? 595;
    setPageScale(Math.min(1.6, target / firstWidth));
    setPageMeta(metas);
    setPageCount(n);
    setProgress({ done: 0, total: n, label: 'Rendering pages…' });
    if (announce) {
      await yieldToBrowser(); // let the For rows mount before painting
      for (let p = 1; p <= n; p += 1) {
        setProgress({ done: p - 1, total: n, label: `Rendering page ${p}` });
        const canvas = pageCanvases.get(p);
        if (!canvas) continue;
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: pageScale() });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        if (!canvas.getContext('2d')) continue;
        await page.render({ canvas, viewport }).promise;
        setProgress({ done: p, total: n, label: `Rendering page ${p}` });
        await yieldToBrowser();
      }
    } else {
      await yieldToBrowser();
      await renderAllPages();
    }
  };

  const pickFile = async (files: File[]) => {
    const candidate = files[0];
    if (!candidate) return;
    if (!isPdfFile(candidate)) {
      setError(`"${cleanFileName(candidate.name)}" is not a PDF.`);
      return;
    }
    setError('');
    setStamps([]);
    setSelected(null);
    setSig(null);
    setPlacing(false);
    setFieldValues({});
    setFormApplied(false);
    setForm(null);
    setFile({
      id: 'pdf',
      name: cleanFileName(candidate.name),
      size: candidate.size,
      type: candidate.type,
      file: candidate,
    });
    setPhase('loading');
    try {
      const bytes = await readFileBytes(candidate);
      await openDocument(bytes, true);
      setWorkingBytes(bytes);
      const scan = await scanForm(bytes);
      setForm(scan);
      setPhase('ready');
    } catch (err) {
      setPhase('empty');
      setFile(null);
      setError(err instanceof Error ? err.message : 'Could not open this PDF.');
    }
  };

  const clear = () => {
    if (doc) disposePdf(doc);
    doc = null;
    setFile(null);
    setWorkingBytes(null);
    setPageCount(0);
    setPageMeta([]);
    setForm(null);
    setFieldValues({});
    setFormApplied(false);
    setStamps([]);
    setSelected(null);
    setSig(null);
    setPlacing(false);
    setPhase('empty');
    setError('');
  };

  /* ---------------- form filling ---------------- */

  const getFieldValue = (name: string): string | boolean =>
    (fieldValues()[name] as string | boolean) ?? '';

  const setFieldValue = (name: string, value: string | boolean) =>
    setFieldValues({ ...fieldValues(), [name]: value });

  const applyForm = async () => {
    if (!workingBytes()) return;
    expandAds();
    const updates: FieldUpdate[] = Object.entries(fieldValues())
      .filter(([, value]) => value !== '' && value !== false)
      .map(([name, value]) => ({ name, type: fieldType(name) ?? 'text', value }));
    if (updates.length === 0) return;

    setPhase('processing');
    setError('');
    setProgress({ done: 0, total: 2, label: 'Applying form fill…' });
    try {
      const out = await fillForm(workingBytes()!, updates);
      setProgress({ done: 1, total: 2, label: 'Re-rendering pages…' });
      await openDocument(out, false);
      setWorkingBytes(out);
      setProgress({ done: 2, total: 2, label: 'Done' });
      setPhase('ready');
      setFormApplied(true);
    } catch (err) {
      setPhase('ready');
      setError(err instanceof Error ? err.message : 'Could not apply the form fill.');
    }
  };

  /* ---------------- signatures ---------------- */

  const adoptSignature = (png: Uint8Array, width: number, height: number) => {
    const blob = new Blob([png.buffer as ArrayBuffer], { type: 'image/png' });
    const dataUrl = URL.createObjectURL(blob);
    setSig({ png, dataUrl, width, height });
    setPlacing(true);
    setSelected(null);
    setError('');
  };

  let drawnPad: SignaturePadApi | null = null;

  const useDrawnSignature = async () => {
    if (!drawnPad) return;
    const png = await drawnPad.getPng();
    if (!png) {
      setError('Draw your signature first.');
      return;
    }
    const size = drawnPad.size();
    if (size.width === 0) return;
    adoptSignature(png, size.width, size.height);
  };

  const useTypedSignature = async () => {
    const text = typedText().trim();
    if (!text) {
      setError('Type your name first.');
      return;
    }
    const font =
      'italic 700 64px "Segoe Script", "Brush Script MT", "Snell Roundhand", "Apple Chancery", cursive';
    const probe = document.createElement('canvas');
    const probeCtx = probe.getContext('2d');
    if (!probeCtx) return;
    probeCtx.font = font;
    const textWidth = Math.ceil(probeCtx.measureText(text).width);
    const width = Math.min(1400, Math.max(320, textWidth + 80));
    const height = 190;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.font = font;
    ctx.fillStyle = '#111827';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 40, height / 2);
    const png = await canvasToPng(canvas);
    adoptSignature(png, width, height);
  };

  const useUploadedSignature = async (files: File[]) => {
    const candidate = files[0];
    if (!candidate) return;
    try {
      const bitmap = await createImageBitmap(candidate, { imageOrientation: 'from-image' });
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = longest > 800 ? 800 / longest : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const png = await canvasToPng(canvas);
      adoptSignature(png, canvas.width, canvas.height);
    } catch {
      setError('Could not read that image. Use PNG or JPEG with a transparent/clean background.');
    }
  };

  /* ---------------- stamp placement ---------------- */

  const onStageClick = (p: number) => (e: MouseEvent) => {
    const s = sig();
    if (!s || !placing()) return;
    const canvas = pageCanvases.get(p);
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left);
    const y = Math.max(0, e.clientY - rect.top);
    const w = stampWidth();
    const h = Math.max(8, (w * s.height) / s.width);
    const id = nextStampId();
    expandAds();
    setStamps([...stamps(), { id, page: p, x, y, w, h, png: s.png, dataUrl: s.dataUrl }]);
    setSelected(id);
  };

  const removeStamp = (id: string) => {
    setStamps(stamps().filter((s) => s.id !== id));
    if (selected() === id) setSelected(null);
  };

  const resizeStamp = (id: string, width: number) => {
    setStamps(
      stamps().map((s) => {
        if (s.id !== id) return s;
        const ratio = s.png.byteLength > 0 ? s.h / s.w : 0.4;
        return { ...s, w: width, h: Math.max(8, width * ratio) };
      }),
    );
  };

  /* ---------------- download ---------------- */

  const download = async () => {
    if (!file() || !workingBytes()) return;
    if (stamps().length === 0 && !formApplied()) {
      setError('Place a signature (or fill a form field) before downloading.');
      return;
    }
    setPhase('processing');
    setError('');
    setProgress({
      done: 0,
      total: 3,
      label: stamps().length > 0 ? 'Flattening signatures…' : 'Preparing PDF…',
    });
    try {
      const scale = pageScale();
      const stampsPt = stamps().map((s) => ({
        page: s.page,
        x: s.x / scale,
        y: s.y / scale,
        width: s.w / scale,
        height: s.h / scale,
        png: s.png,
      }));
      // Form-only documents carry no stamps — the filled bytes are ready as-is.
      const out =
        stamps().length > 0
          ? await placeSignatures(workingBytes()!, stampsPt)
          : new Uint8Array(workingBytes()!);
      setProgress({ done: 3, total: 3, label: 'Done' });
      saveBlob(
        out,
        `${file()!.name.replace(/\.pdf$/i, '') || 'document'}-signed.pdf`,
        'application/pdf',
      );
      setPhase('ready');
    } catch (err) {
      setPhase('ready');
      setError(err instanceof Error ? err.message : 'Could not save the signed PDF.');
    }
  };

  const hasFormFields = () => (form()?.fields.length ?? 0) > 0;

  return (
    <>
      <Title>{meta.title}</Title>
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/pdf-sign`} />
      {meta.image && <Meta property="og:image" content={meta.image} />}
      <script type="application/ld+json" innerHTML={JSON.stringify(jsonLdFor('/pdf-sign'))} />

      <ToolPage
        title="Sign & Fill PDF"
        lede="Add a drawn, typed or uploaded signature anywhere on the page, and fill standard PDF form fields. The document stays on your device the whole time."
        related={[
          { path: '/pdf-compress', label: 'Compress PDF' },
          { path: '/image-to-pdf', label: 'Image to PDF' },
          { path: '/pdf-to-image', label: 'PDF to image' },
        ]}
      >
        <ToolColumns
          aside={
            <>
              <div class="panel">
                <div class="panel-title">Signature</div>
                <div class="panel-body">
                  <div class="tabs" role="tablist">
                    {(['draw', 'type', 'upload'] as SigTab[]).map((tab) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={sigTab() === tab}
                        class={`tab ${sigTab() === tab ? 'active' : ''}`}
                        onClick={() => setSigTab(tab)}
                      >
                        {tab === 'draw' ? 'Draw' : tab === 'type' ? 'Type' : 'Upload'}
                      </button>
                    ))}
                  </div>
                  <Show when={sigTab() === 'draw'}>
                    <SignaturePad onApi={(api) => (drawnPad = api)} />
                    <button
                      type="button"
                      class="btn btn-primary btn-block"
                      style="margin-top: 0.6rem"
                      onClick={useDrawnSignature}
                    >
                      Use this signature
                    </button>
                  </Show>
                  <Show when={sigTab() === 'type'}>
                    <div class="field">
                      <span>Your name</span>
                      <input
                        type="text"
                        value={typedText()}
                        onInput={(e) => setTypedText(e.currentTarget.value)}
                        placeholder="e.g. Alex Rivera"
                        style="font-family: cursive; font-size: 1.1rem"
                      />
                    </div>
                    <button
                      type="button"
                      class="btn btn-primary btn-block"
                      style="margin-top: 0.4rem"
                      onClick={useTypedSignature}
                    >
                      Use this signature
                    </button>
                  </Show>
                  <Show when={sigTab() === 'upload'}>
                    <DropZone
                      accept="image/png,image/jpeg,image/webp"
                      title="Drop a signature image"
                      subtitle="PNG with transparency works best"
                      onFiles={useUploadedSignature}
                    />
                  </Show>
                  <Show when={sig()}>
                    <div class="sig-preview">
                      <img src={sig()!.dataUrl} alt="Current signature" />
                      <span class="file-size">
                        {sig()!.width}×{sig()!.height}px
                      </span>
                    </div>
                    <div class="range-row" style="margin-top: 0.5rem">
                      <input
                        type="range"
                        min={60}
                        max={420}
                        step={5}
                        value={stampWidth()}
                        onChange={(e) => setStampWidth(Number(e.currentTarget.value))}
                        aria-label="Stamp width"
                      />
                      <output>{stampWidth()}</output>
                    </div>
                    <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem">
                      <button
                        type="button"
                        class="btn btn-sm btn-ghost"
                        onClick={() => setPlacing(!placing())}
                      >
                        {placing() ? 'Stop placing' : 'Place on a page'}
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm btn-ghost"
                        onClick={() => {
                          setSig(null);
                          setPlacing(false);
                        }}
                      >
                        Discard
                      </button>
                    </div>
                  </Show>
                </div>
              </div>

              <Show when={form()?.xfa}>
                <div class="error-card" role="alert" style="margin-top: 1rem">
                  <AlertIcon />
                  <span>
                    This PDF uses a legacy XFA form — field filling is not supported, but you can
                    still add signatures.
                  </span>
                </div>
              </Show>

              <Show when={hasFormFields() && !form()?.xfa}>
                <div class="panel" style="margin-top: 1rem">
                  <div class="panel-title">Form fields</div>
                  <div class="panel-body" style="max-height: 340px; overflow-y: auto">
                    <For each={form()!.fields}>
                      {(f: FieldInfo) => (
                        <div class="field">
                          <span title={f.name}>{f.name}</span>
                          <Show when={f.type === 'text' || f.type === 'date'}>
                            <input
                              type="text"
                              disabled={f.type === 'date'}
                              placeholder={
                                f.type === 'date'
                                  ? 'Date fields are not fillable in this build'
                                  : 'Value'
                              }
                              value={
                                typeof getFieldValue(f.name) === 'string'
                                  ? (getFieldValue(f.name) as string)
                                  : ''
                              }
                              onInput={(e) => setFieldValue(f.name, e.currentTarget.value)}
                            />
                          </Show>
                          <Show when={f.type === 'checkbox'}>
                            <label class="toggle">
                              <input
                                type="checkbox"
                                checked={Boolean(getFieldValue(f.name))}
                                onChange={(e) => setFieldValue(f.name, e.currentTarget.checked)}
                              />
                              <span class="knob" />
                              <span>Checked</span>
                            </label>
                          </Show>
                          <Show when={f.type === 'radio' || f.type === 'dropdown'}>
                            <select
                              value={String(getFieldValue(f.name))}
                              onChange={(e) => setFieldValue(f.name, e.currentTarget.value)}
                            >
                              <option value="">—</option>
                              {(f.choices ?? []).map((choice) => (
                                <option value={choice}>{choice}</option>
                              ))}
                            </select>
                          </Show>
                        </div>
                      )}
                    </For>
                    <button
                      type="button"
                      class="btn btn-primary btn-block"
                      style="margin-top: 0.8rem"
                      onClick={applyForm}
                      disabled={phase() !== 'ready'}
                    >
                      Apply form fill
                    </button>
                  </div>
                </div>
              </Show>

              <AdSlot slot="tool-bottom" className="aside-ad" />
            </>
          }
        >
          <div class="panel">
            <div class="panel-body">
              <ChainNote note={chain.note} dismiss={chain.dismissNote} />
              <Show when={!file() || phase() === 'empty'}>
                <DropZone
                  accept="application/pdf,.pdf"
                  title="Drop a PDF to sign or fill"
                  subtitle="your document never leaves this device"
                  busy={phase() === 'loading'}
                  onFiles={pickFile}
                />
              </Show>
              <Show when={file()}>
                <div class="file-row" style="margin-bottom: 0.5rem">
                  <span class="file-name" title={file()!.name}>
                    {file()!.name}
                  </span>
                  <span class="file-size">
                    {humanSize(file()!.size)} · {pageCount()} pages
                  </span>
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

              <Show when={placing()}>
                <div class="placing-banner" role="status">
                  Click a page where the signature should go. Click a placed stamp to select or
                  remove it.
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

          <Show when={phase() !== 'empty' && phase() !== 'loading' && pageCount() > 0}>
            <div class="pages-vertical">
              <For each={pageMeta()}>
                {(_, index) => {
                  const p = index() + 1;
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: canvas-like placement surface; stamps are focusable buttons
                    <div
                      class="stage"
                      data-page={p}
                      data-placing={placing() ? 'true' : 'false'}
                      onClick={onStageClick(p)}
                    >
                      <canvas
                        class="stage-canvas"
                        ref={(el) => {
                          if (el) pageCanvases.set(p, el);
                          else pageCanvases.delete(p);
                        }}
                      />
                      <For each={stamps().filter((s) => s.page === p)}>
                        {(s) => (
                          <button
                            type="button"
                            class={`stamp ${s.id === selected() ? 'selected' : ''}`}
                            style={{
                              left: `${s.x}px`,
                              top: `${s.y}px`,
                              width: `${s.w}px`,
                              height: `${s.h}px`,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(s.id);
                            }}
                            aria-label={`Signature on page ${p} — press Enter to remove`}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === 'Delete') removeStamp(s.id);
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
            </div>

            <Show when={selectedStamp()}>
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
                    value={selectedStamp()!.w}
                    onChange={(e) =>
                      resizeStamp(selectedStamp()!.id, Number(e.currentTarget.value))
                    }
                    style="flex: 1; min-width: 140px"
                  />
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    onClick={() => removeStamp(selectedStamp()!.id)}
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
                  onClick={download}
                  disabled={(stamps().length === 0 && !formApplied()) || phase() === 'processing'}
                >
                  <DownloadIcon />
                  {stamps().length > 0
                    ? `Download signed PDF (${stamps().length} ${stamps().length === 1 ? 'stamp' : 'stamps'})`
                    : formApplied()
                      ? 'Download filled PDF'
                      : 'Place a signature to download'}
                </button>
              </div>
            </div>
          </Show>

          <Show when={phase() === 'loading' || phase() === 'processing'}>
            <div class="panel">
              <ProgressBar
                done={progress().done}
                total={progress().total}
                label={progress().label}
              />
            </div>
            <AdSlot slot="processing" className="processing-ad" />
          </Show>
        </ToolColumns>
      </ToolPage>
    </>
  );
}
