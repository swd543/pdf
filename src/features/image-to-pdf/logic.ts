/**
 * Image → PDF logic.
 *
 * Pipeline per image:
 *  - JPEG with normal EXIF orientation  → embed raw bytes (fast, zero
 *    quality loss — this is the common photo case).
 *  - 8-bit RGB/RGBA PNG                 → embed raw (pdf-lib handles alpha).
 *  - Everything else (WebP, GIF, BMP, AVIF, 16-bit PNG, rotated JPEG) →
 *    decode with createImageBitmap (EXIF applied), optionally downscale,
 *    re-encode to JPEG on a white background.
 *
 * All page layout math happens in points (1pt = 1/72in), the PDF unit.
 */

import type { PDFDocument } from 'pdf-lib';
import { readFileBytes } from '~/lib/files';
import {
  isJpegBytes,
  isNormalOrientation,
  isPngBytes,
  jpegDimensions,
  jpegOrientation,
  pngBitDepth,
  pngDimensions,
} from '~/lib/image-meta';
import { canvasToPng, downscaleBitmap, fileToBitmap, renderWhiteJpeg } from '~/lib/imaging';
import type { OperationContext } from '~/lib/operation';
import { pdflib } from '~/lib/pdflib';
import type { ProgressFn } from '~/lib/types';
import { yieldToBrowser } from '~/lib/types';

export type PageSize = 'fit' | 'a4' | 'letter' | 'legal';

export interface ImageToPdfOptions {
  /** Page size; 'fit' makes each page match the image. */
  pageSize: PageSize;
  /** Page margin in points (0 = none). */
  marginPt: number;
  /** Cancellation context — checkpoint between images (P1.6). */
  op?: OperationContext;
}

/** Standard page sizes in points. */
export const PAGE_SIZES: Record<Exclude<PageSize, 'fit'>, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
};

/** Screen-ish scale for fit-to-image pages: 96 px/in → 72 pt/in. */
const FIT_SCALE = 72 / 96;
/** Hard cap for page size (PDF viewers get grumpy beyond ~200in). */
const MAX_PAGE_PT = 14400;
/** Cap for re-encoded images to keep canvases sane. */
const MAX_REENCODE_SIDE = 4096;
/** JPEG quality for the re-encode path (visually lossless). */
const JPEG_QUALITY = 0.92;

export interface PreparedImage {
  bytes: Uint8Array;
  kind: 'jpeg' | 'png';
  width: number;
  height: number;
}

/** Prepare one image file for PDF embedding (see module docs). */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const raw = new Uint8Array(await readFileBytes(file));

  const looksJpeg = file.type === 'image/jpeg' || isJpegBytes(raw);
  const looksPng = file.type === 'image/png' || isPngBytes(raw);

  if (looksJpeg) {
    const orientation = jpegOrientation(raw);
    if (isNormalOrientation(orientation)) {
      const dims = jpegDimensions(raw);
      if (dims) return { bytes: raw, kind: 'jpeg', width: dims.width, height: dims.height };
    }
    // Rotated or unreadable header → re-encode through the bitmap path.
  }

  if (looksPng) {
    const dims = pngDimensions(raw);
    const bitDepth = pngBitDepth(raw);
    if (dims && bitDepth === 8) {
      // pdf-lib embeds 8-bit RGB/RGBA/gray PNGs natively (alpha preserved).
      return { bytes: raw, kind: 'png', width: dims.width, height: dims.height };
    }
  }

  // Generic path: decode (EXIF applied by the browser), downscale if huge,
  // re-encode to JPEG on a white background.
  const bitmap = await fileToBitmap(file);
  let scaled: ImageBitmap | null = null;
  try {
    scaled = await downscaleBitmap(bitmap, MAX_REENCODE_SIDE);
    const bytes = await renderWhiteJpeg(scaled, JPEG_QUALITY);
    return { bytes, kind: 'jpeg', width: scaled.width, height: scaled.height };
  } finally {
    bitmap.close();
    if (scaled && scaled !== bitmap) scaled.close(); // downscale made a new one
  }
}

/**
 * Output page geometry for an image, in PDF points.
 * Shared by the real PDF writer (`addImagePage`) and Merge's CSS preview,
 * so the preview cannot drift from what is actually written.
 */
export function imagePageDimensions(
  imageWidth: number,
  imageHeight: number,
  pageSize: PageSize,
): [number, number] {
  if (pageSize === 'fit') {
    return [clamp(imageWidth * FIT_SCALE), clamp(imageHeight * FIT_SCALE)];
  }
  return PAGE_SIZES[pageSize];
}

/**
 * Add one prepared image as a new page, centered with the requested
 * margins. Shared with the merge tool (type-only pdf-lib import keeps this
 * module code-split).
 */
export async function addImagePage(
  doc: PDFDocument,
  prep: PreparedImage,
  options: ImageToPdfOptions,
): Promise<void> {
  const margin = options.marginPt;
  const [pageW, pageH] = imagePageDimensions(prep.width, prep.height, options.pageSize);

  // Letterbox the image inside the page, centered.
  const boxW = pageW - margin * 2;
  const boxH = pageH - margin * 2;
  if (boxW <= 0 || boxH <= 0) throw new Error('Margin is larger than the page');
  const scale = Math.min(boxW / prep.width, boxH / prep.height);
  const imgW = prep.width * scale;
  const imgH = prep.height * scale;
  const x = (pageW - imgW) / 2;
  const y = (pageH - imgH) / 2;

  const image =
    prep.kind === 'jpeg' ? await doc.embedJpg(prep.bytes) : await doc.embedPng(prep.bytes);
  const page = doc.addPage([pageW, pageH]);
  page.drawImage(image, { x, y, width: imgW, height: imgH });
}

/**
 * Combine image files into a single PDF.
 * Returns the output bytes; reports progress per image.
 */
export async function imagesToPdf(
  files: File[],
  options: ImageToPdfOptions,
  onProgress: ProgressFn,
): Promise<Uint8Array> {
  if (files.length === 0) throw new Error('No images selected');
  const { PDFDocument } = await pdflib();
  const doc = await PDFDocument.create();
  doc.setTitle('Document');
  doc.setProducer('PDFBoogie (in-browser, no upload)');

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    onProgress(i, files.length, `Preparing ${file.name}`);
    if (options.op) await options.op.checkpoint();
    else await yieldToBrowser();

    const prep = await prepareImage(file);
    onProgress(i + 0.5, files.length, `Embedding ${file.name}`);
    await addImagePage(doc, prep, options);

    if (options.op) await options.op.checkpoint();
    else await yieldToBrowser();
  }

  onProgress(files.length, files.length, 'Assembling PDF');
  return doc.save();
}

function clamp(pt: number): number {
  return Math.min(MAX_PAGE_PT, Math.max(72, Math.round(pt * 100) / 100));
}

/** Re-export for callers that need PNG conversion (e.g. signature flows). */
export { canvasToPng };
