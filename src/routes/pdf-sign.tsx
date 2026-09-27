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
import { createSignal, onCleanup, Show } from 'solid-js';
import { AdSlot } from '~/components/AdSlot';
import { Canonical } from '~/components/Canonical';
import { AlertIcon } from '~/components/Icons';
import { ProgressBar, ToolColumns, ToolPage } from '~/components/Shell';
import type { SignaturePadApi } from '~/components/SignaturePad';
import { SinglePdfInput } from '~/components/SinglePdfInput';
import { FormPanel } from '~/features/pdf-sign/FormPanel';
import {
  type FieldType,
  type FieldUpdate,
  type FormScan,
  fillForm,
  placeSignatures,
  type Signature,
  type SigTab,
  type StampView,
  scanForm,
} from '~/features/pdf-sign/logic';
import { PdfStage } from '~/features/pdf-sign/PdfStage';
import { type PageMeta, SignPageRenderer } from '~/features/pdf-sign/page-renderer';
import { SignatureChooser } from '~/features/pdf-sign/SignatureChooser';
import { useChainedPdf } from '~/lib/chain';
import { saveBlob } from '~/lib/download';
import { cleanFileName, readFileBytes } from '~/lib/files';
import { canvasToPng } from '~/lib/imaging';
import { createObjectUrlRegistry } from '~/lib/object-urls';
import { type FileItem, isPdfFile } from '~/lib/types';
import { expandAds } from '~/site/ads';
import { siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

type Phase = 'empty' | 'loading' | 'ready' | 'processing';

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

  // DOM refs for the page canvases (keyed by 1-based page number)
  const pageCanvases = new Map<number, HTMLCanvasElement>();
  /** Stage elements for the IntersectionObserver (lazy render window). */
  const stageEls = new Map<number, HTMLDivElement>();

  /* ---------------- document loading ---------------- */
  // Lazy bounded rendering (handoff P0.1): the renderer owns the PDF.js
  // document; the observer decides which pages keep a live canvas.
  let renderer: SignPageRenderer | null = null;
  const visibleStages = new Set<number>();
  const stageObserver =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const p = Number((entry.target as HTMLElement).dataset.page);
              if (!Number.isFinite(p) || p < 1) continue;
              if (entry.isIntersecting) visibleStages.add(p);
              else visibleStages.delete(p);
            }
            renderer?.syncWindow(desiredWindow());
          },
          { rootMargin: '256px 0px' },
        )
      : null;

  onCleanup(() => {
    stageObserver?.disconnect();
    void renderer?.dispose();
  });

  /** Pages to keep live: a page of each visible stage plus its neighbours,
   *  most-visible first (the renderer keeps only the first few). */
  const desiredWindow = (): number[] => {
    if (visibleStages.size === 0) return [];
    const top = Math.min(...visibleStages);
    const want = new Set<number>();
    for (const p of visibleStages) for (const q of [p - 1, p, p + 1]) want.add(q);
    return [...want].sort((a, b) => Math.abs(a - top) - Math.abs(b - top));
  };

  const teardownRenderer = async () => {
    const r = renderer;
    renderer = null;
    visibleStages.clear();
    if (r) await r.dispose();
  };

  const openDocument = async (bytes: ArrayBuffer | Uint8Array) => {
    await teardownRenderer();
    setProgress({ done: 0, total: 1, label: 'Opening PDF…' });
    // pdfjs detaches the buffer it is given — hand it a real copy so
    // `bytes` stays usable for the form scan and the download.
    const copy = new Uint8Array(bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.slice());
    const r = new SignPageRenderer();
    const metas = await r.open(copy, 1);
    const n = metas.length;
    if (n === 0) {
      await r.dispose();
      throw new Error('This PDF has no pages');
    }
    // Adaptive display width so big documents stay light (same formula as
    // the old eager renderer).
    const target = n <= 10 ? 560 : n <= 50 ? 420 : 300;
    const firstWidth = metas[0]?.widthPt ?? 595;
    const scale = Math.min(1.6, target / firstWidth);
    renderer = r;
    r.setScale(scale); // safe: nothing has rendered yet
    setPageScale(scale);
    setPageMeta(metas);
    setPageCount(n);
  };

  const fieldType = (name: string): FieldType | undefined =>
    form()?.fields.find((f) => f.name === name)?.type;

  const selectedStamp = () => stamps().find((s) => s.id === selected()) ?? null;

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
      await openDocument(bytes);
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
    void teardownRenderer();
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
      await openDocument(out);
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
  // Object URLs for signature previews are route-owned resources
  // (handoff P0.4); the registry revokes them on replace/clear/unmount.
  const sigUrls = createObjectUrlRegistry();
  onCleanup(() => sigUrls.clear());

  const adoptSignature = (png: Uint8Array, width: number, height: number) => {
    const old = sig();
    if (old) sigUrls.revoke(old.dataUrl);
    const blob = new Blob([png.buffer as ArrayBuffer], { type: 'image/png' });
    const dataUrl = sigUrls.create(blob);
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
      try {
        const longest = Math.max(bitmap.width, bitmap.height);
        const scale = longest > 800 ? 800 / longest : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const png = await canvasToPng(canvas);
        const w = canvas.width;
        const h = canvas.height;
        canvas.width = 0;
        canvas.height = 0; // release the backing store
        adoptSignature(png, w, h);
      } finally {
        bitmap.close(); // caller-owned bitmap (P0.4)
      }
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
      <Canonical path="/pdf-sign" />
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/pdf-sign/`} />
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
              <SignatureChooser
                sigTab={sigTab}
                setSigTab={setSigTab}
                onPadApi={(api) => (drawnPad = api)}
                onUseDrawn={() => void useDrawnSignature()}
                onUseTyped={() => void useTypedSignature()}
                onUpload={useUploadedSignature}
                typedText={typedText}
                setTypedText={setTypedText}
                sig={sig}
                stampWidth={stampWidth}
                setStampWidth={setStampWidth}
                placing={placing}
                onTogglePlacing={() => setPlacing(!placing())}
                onDiscard={() => {
                  setSig(null);
                  setPlacing(false);
                }}
              />

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
                <FormPanel
                  fields={() => form()!.fields}
                  getFieldValue={getFieldValue}
                  setFieldValue={setFieldValue}
                  onApply={() => void applyForm()}
                  applyDisabled={() => phase() !== 'ready'}
                />
              </Show>

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
                dropTitle="Drop a PDF to sign or fill"
                dropSubtitle="your document never leaves this device"
                busy={phase() === 'loading'}
                disableRemove={phase() === 'processing'}
                note={chain.note}
                dismissNote={chain.dismissNote}
                onFiles={pickFile}
                onClear={clear}
              />

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
            <PdfStage
              pageMeta={pageMeta}
              stamps={stamps}
              selected={selected}
              placing={placing}
              registerStage={(p, el) => {
                if (el) {
                  stageEls.set(p, el);
                  stageObserver?.observe(el);
                } else {
                  const gone = stageEls.get(p);
                  if (gone) stageObserver?.unobserve(gone);
                  stageEls.delete(p);
                }
              }}
              registerCanvas={(p, el) => {
                if (el) pageCanvases.set(p, el);
                else pageCanvases.delete(p);
                renderer?.registerCanvas(p, el);
              }}
              onStageClick={onStageClick}
              onStampClick={(id) => setSelected(id)}
              onStampRemoveKey={removeStamp}
              selectedStamp={selectedStamp}
              onResizeStamp={resizeStamp}
              onRemoveStamp={removeStamp}
              downloadLabel={() =>
                stamps().length > 0
                  ? `Download signed PDF (${stamps().length} ${stamps().length === 1 ? 'stamp' : 'stamps'})`
                  : formApplied()
                    ? 'Download filled PDF'
                    : 'Place a signature to download'
              }
              downloadDisabled={() =>
                (stamps().length === 0 && !formApplied()) || phase() === 'processing'
              }
              onDownload={download}
            />
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
