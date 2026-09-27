/**
 * Image → PDF tool page.
 *
 * State machine: empty → ready (files listed) → processing → done.
 * All heavy lifting lives in `./logic` (unit-testable, lazy-loaded deps).
 */

import { Meta, Title } from '@solidjs/meta';
import { createSignal, For, Show } from 'solid-js';
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
import { imagesToPdf, type PageSize } from '~/features/image-to-pdf/logic';
import { saveBlob } from '~/lib/download';
import { cleanFileName, humanSize, nextId } from '~/lib/files';
import { type FileItem, isImageFile, yieldToBrowser } from '~/lib/types';
import { expandAds } from '~/site/ads';
import { siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

interface Item extends FileItem {
  thumb: string | null;
  width: number;
  height: number;
}

type Phase = 'empty' | 'ready' | 'processing' | 'done';

const MAX_FILES = 50;

export default function ImageToPdfPage() {
  const meta = routeMeta['/image-to-pdf']!;

  const [items, setItems] = createSignal<Item[]>([]);
  const [phase, setPhase] = createSignal<Phase>('empty');
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal({ done: 0, total: 1, label: '' });
  const [result, setResult] = createSignal<{ bytes: Uint8Array; name: string } | null>(null);

  const [pageSize, setPageSize] = createSignal<PageSize>('fit');
  const [margin, setMargin] = createSignal(0);

  const baseName = () => {
    const first = items()[0];
    if (items().length === 1 && first) return first.name.replace(/\.[^.]+$/, '') || 'image';
    return 'images';
  };

  const totalInputSize = () => items().reduce((sum, i) => sum + i.size, 0);

  const addFiles = async (files: File[]) => {
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (isImageFile(file)) accepted.push(file);
      else rejected.push(cleanFileName(file.name));
    }
    const truncated = accepted.length > MAX_FILES - items().length;
    const toAdd = accepted.slice(0, MAX_FILES - items().length);

    const errors: string[] = [];
    if (rejected.length > 0)
      errors.push(
        `Not images: ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? '…' : ''}`,
      );
    if (truncated) errors.push(`Limit is ${MAX_FILES} images — extras were skipped.`);
    setError(errors.join(' '));

    for (const file of toAdd) {
      const url = URL.createObjectURL(file);
      let width = 0;
      let height = 0;
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
      } catch {
        /* dimensions are cosmetic — ignore decode failures */
      }
      await yieldToBrowser();
      setItems([
        ...items(),
        {
          id: nextId('img'),
          name: cleanFileName(file.name),
          size: file.size,
          type: file.type,
          file,
          thumb: url,
          width,
          height,
        },
      ]);
    }
    if (toAdd.length > 0) {
      setResult(null);
      setPhase('ready');
    }
  };

  const move = (id: string, dir: -1 | 1) => {
    const list = [...items()];
    const from = list.findIndex((x) => x.id === id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= list.length) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item!);
    setItems(list);
  };

  const remove = (id: string) => {
    const item = items().find((x) => x.id === id);
    if (item?.thumb) URL.revokeObjectURL(item.thumb);
    const list = items().filter((x) => x.id !== id);
    setItems(list);
    if (list.length === 0) {
      setPhase('empty');
      setResult(null);
    }
  };

  const process = async () => {
    if (items().length === 0 || phase() !== 'ready') return;
    expandAds();
    setPhase('processing');
    setError('');
    setResult(null);
    setProgress({ done: 0, total: items().length, label: 'Starting…' });
    try {
      const bytes = await imagesToPdf(
        items().map((i) => i.file),
        { pageSize: pageSize(), marginPt: margin() },
        (done, total, label) => setProgress({ done, total, label: label ?? '' }),
      );
      setResult({ bytes, name: `${baseName()}.pdf` });
      setPhase('done');
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
    setPhase('empty');
    setResult(null);
  };

  return (
    <>
      <Title>{meta.title}</Title>
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/image-to-pdf`} />
      {meta.image && <Meta property="og:image" content={meta.image} />}
      <script type="application/ld+json" innerHTML={JSON.stringify(jsonLdFor('/image-to-pdf'))} />

      <ToolPage
        title="Image to PDF"
        lede="Combine JPG, PNG, WebP, GIF, BMP and AVIF images into a single PDF. Reorder, pick page sizes and download — all without uploading a single byte."
        related={[
          { path: '/pdf-compress', label: 'Compress PDF' },
          { path: '/pdf-to-image', label: 'PDF to image' },
          { path: '/pdf-sign', label: 'Sign & fill' },
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
                    <label for="pageSize">Page size</label>
                    <select
                      id="pageSize"
                      value={pageSize()}
                      onChange={(e) => setPageSize(e.currentTarget.value as PageSize)}
                    >
                      <option value="fit">Fit to image</option>
                      <option value="a4">A4</option>
                      <option value="letter">Letter</option>
                      <option value="legal">Legal</option>
                    </select>
                    <p class="opt-hint">Fit-to-image makes each page match its image.</p>
                  </div>
                  <div class="opt-group">
                    <label for="margin">Margins</label>
                    <select
                      id="margin"
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
                  <h3>JPG, PNG &amp; friends</h3>
                  <p style="font-size: 0.88rem; color: var(--ink-muted); margin: 0">
                    Photos with normal orientation are embedded without re-encoding, so quality is
                    preserved. Everything else is converted in your browser.
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
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
                multiple
                title="Drop images here"
                subtitle="JPG, PNG, WebP, GIF, BMP, AVIF"
                busy={phase() === 'processing'}
                onFiles={addFiles}
              />
              <Show when={items().length > 0}>
                <ul class="filelist" aria-label="Selected images">
                  <For each={items()}>
                    {(item) => (
                      <li class="file-row">
                        {item.thumb ? (
                          <img class="file-thumb" src={item.thumb} alt="" />
                        ) : (
                          <span class="file-thumb" />
                        )}
                        <span class="file-name" title={item.name}>
                          {item.name}
                        </span>
                        <span class="file-size">
                          {humanSize(item.size)}
                          {item.width > 0 ? ` · ${item.width}×${item.height}` : ''}
                        </span>
                        <span class="file-actions">
                          <button
                            type="button"
                            class="btn btn-sm btn-icon btn-ghost"
                            aria-label={`Move ${item.name} up`}
                            onClick={() => move(item.id, -1)}
                            disabled={phase() !== 'ready'}
                          >
                            <ArrowUpIcon />
                          </button>
                          <button
                            type="button"
                            class="btn btn-sm btn-icon btn-ghost"
                            aria-label={`Move ${item.name} down`}
                            onClick={() => move(item.id, 1)}
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
                  disabled={items().length === 0}
                >
                  <SpinnerIcon />
                  Combine {items().length} {items().length === 1 ? 'image' : 'images'} into a PDF
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
                  <span class="was">{humanSize(totalInputSize())} of images</span>
                  <span class="now">{humanSize(result()!.bytes.byteLength)}</span>
                  <span class="delta neutral">PDF · {items().length} pages</span>
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
