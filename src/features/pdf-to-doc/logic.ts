/**
 * PDF → DOCX / ODT conversion logic.
 *
 * Honest approach: a PDF is a *paint* format — it stores where glyphs are
 * drawn, not a document model. So we reconstruct the **text flow** from
 * glyph metrics: reading order, lines → paragraphs, and basic styling
 * (font size, bold, italic, headings). Tables, images, and complex
 * multi-column layouts are not preserved (disclosed in the UI).
 *
 * The writers are hand-rolled, minimal OOXML (Word `.docx`) and
 * OpenDocument (`.odt`) emitters over fflate ZIP archives — no heavyweight
 * document library, so the bundle stays small.
 *
 * The text-flow reconstruction (`itemsToBlocks`) and both writers are pure
 * and unit-tested in Node; only the pdfjs extraction needs a browser.
 */
import { strToU8, type Zippable, zipSync } from 'fflate';
import { disposePdf, pdfDocument } from '~/lib/pdfjs';
import { type ProgressFn, yieldToBrowser } from '~/lib/types';

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

export type DocFormat = 'docx' | 'odt';

/** A styled text run inside a paragraph. */
export interface DocRun {
  text: string;
  /** Font size in points; 0 = document default. */
  sizePt: number;
  bold: boolean;
  italic: boolean;
}

/** A paragraph. `heading`: 0 = body, 1 = h1, 2 = h2. */
export interface DocParagraph {
  type: 'paragraph';
  runs: DocRun[];
  heading: 0 | 1 | 2;
}

/** Page-break marker between extracted pages. */
export interface DocPageBreak {
  type: 'pagebreak';
}

export type DocBlock = DocParagraph | DocPageBreak;

/** One reconstructed document. */
export interface DocText {
  blocks: DocBlock[];
  /** Approximate body font size in points (median of text). */
  bodySizePt: number;
}

/**
 * A raw text item as extracted from one PDF page (PDF user-space points,
 * origin bottom-left, y up).
 */
export interface RawTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Approximate font size in points (glyph height). */
  size: number;
  fontName: string;
  hasEOL: boolean;
}

export interface DocOptions {
  /** 1-based first page to convert (inclusive). */
  from?: number;
  /** 1-based last page to convert (inclusive). */
  to?: number;
  /**
   * Override the body-size estimate (points). When omitted it is derived
   * from the document's median glyph size.
   */
  bodySizePt?: number;
  /** Cancellation context — checkpoint between pages (P1.6). */
  op?: import('~/lib/operation').OperationContext;
}

/* ------------------------------------------------------------------ */
/* Text-flow reconstruction (pure)                                     */
/* ------------------------------------------------------------------ */

interface StyleKey {
  size: number;
  bold: boolean;
  italic: boolean;
}

interface Line {
  /** Top-to-bottom position (PDF y of the line's baseline, high = up). */
  y: number;
  /** Representative (max) font size on the line. */
  size: number;
  runs: DocRun[];
}

const BOLD_RE = /bold|black|heavy|semibold|demi/i;
const ITALIC_RE = /italic|oblique/i;

function styleOf(item: RawTextItem): StyleKey {
  return {
    size: Math.max(1, Math.round(item.size * 2) / 2),
    bold: BOLD_RE.test(item.fontName),
    italic: ITALIC_RE.test(item.fontName),
  };
}

function sameStyle(a: StyleKey, b: StyleKey): boolean {
  return a.size === b.size && a.bold === b.bold && a.italic === b.italic;
}

/** Group a page's items into visual lines, top to bottom. */
function groupLines(items: RawTextItem[]): Line[] {
  // PDF y grows upward → larger y is higher on the page.
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  let current: RawTextItem[] = [];

  const flush = () => {
    if (current.length === 0) return;
    lines.push(buildLine(current));
    current = [];
  };

  for (const item of sorted) {
    if (item.str.trim() === '') continue;
    if (current.length === 0) {
      current.push(item);
      continue;
    }
    const anchorY = Math.max(...current.map((i) => i.y));
    const tol = Math.max(2, 0.4 * avgOf(current));
    if (anchorY - item.y <= tol) {
      current.push(item);
    } else {
      flush();
      current.push(item);
    }
  }
  flush();
  return lines;
}

function avgOf(items: RawTextItem[]): number {
  if (items.length === 0) return 10;
  return items.reduce((s, i) => s + (i.h || 10), 0) / items.length;
}

/** Join a line's items into styled runs, inserting spaces at gaps. */
function buildLine(items: RawTextItem[]): Line {
  const runs: DocRun[] = [];
  let max = 0;
  let topY = -Infinity;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    topY = Math.max(topY, item.y);
    const s = styleOf(item);
    max = Math.max(max, item.size);

    // Space between this item and the previous one?
    let needsSpace = false;
    if (i > 0) {
      const prev = items[i - 1]!;
      const gap = item.x - (prev.x + prev.w);
      const threshold = 0.18 * Math.max(2, (prev.size + item.size) / 2);
      needsSpace = gap > threshold && item.str.length > 0;
    }

    const last = runs[runs.length - 1];
    const prefix = needsSpace ? ' ' : '';
    if (last && sameStyle({ size: last.sizePt, bold: last.bold, italic: last.italic }, s)) {
      last.text += prefix + item.str;
    } else {
      runs.push({ text: prefix + item.str, sizePt: s.size, bold: s.bold, italic: s.italic });
    }
  }
  return { y: topY, size: max, runs };
}

/**
 * Reconstruct document text flow from per-page raw items.
 *
 * Lines are grouped into paragraphs using the vertical gap between
 * baselines: a gap larger than ~1.4× the average font size starts a new
 * paragraph. Headings are detected as paragraphs whose size clearly
 * exceeds the document body size.
 */
export function itemsToBlocks(pages: RawTextItem[][]): DocText {
  const blocks: DocBlock[] = [];
  const bodySizes: number[] = [];
  const pageLines: Line[][] = [];

  for (const pageItems of pages) {
    const lines = groupLines(pageItems).filter((l) => l.runs.length > 0);
    pageLines.push(lines);
    for (const line of lines) {
      for (const run of line.runs) {
        // Weight by text volume so body text dominates the median.
        for (let i = 0; i < Math.max(1, Math.round(run.text.length / 4)); i += 1) {
          bodySizes.push(run.sizePt);
        }
      }
    }
  }

  const bodySize = pages.length > 0 && bodySizes.length > 0 ? median(bodySizes) : 11;

  let firstPage = true;
  for (const lines of pageLines) {
    if (lines.length === 0) continue;
    if (!firstPage) blocks.push({ type: 'pagebreak' });
    firstPage = false;

    let para: DocParagraph | null = null;
    let prevLine: Line | null = null;
    for (const line of lines) {
      if (!para || isParagraphBreak(prevLine, line)) {
        if (para) blocks.push(para);
        para = { type: 'paragraph', runs: [], heading: 0 };
      } else {
        // Continue the paragraph: space between lines (wrapped text).
        para.runs.push({ text: ' ', sizePt: 0, bold: false, italic: false });
      }
      para.runs.push(...line.runs);
      prevLine = line;
    }
    if (para) blocks.push(para);
  }

  // Heading detection: dominant size well above body size.
  for (const b of blocks) {
    if (b.type === 'pagebreak') continue;
    const dominant = dominantSize(b);
    if (bodySize > 0 && dominant > bodySize * 1.35) {
      b.heading = dominant > bodySize * 1.9 ? 1 : 2;
    }
  }

  return { blocks, bodySizePt: bodySize };
}

function isParagraphBreak(prev: Line | null, line: Line): boolean {
  if (!prev) return false;
  const gap = prev.y - line.y; // prev is above → larger y
  const avgSize = (prev.size + line.size) / 2;
  if (gap > 1.4 * avgSize) return true;
  // A clear font-size change between lines signals a new block (e.g.
  // heading → body) even when the vertical gap is small.
  const max = Math.max(prev.size, line.size);
  return max > 0 && Math.abs(prev.size - line.size) > 0.3 * max;
}

function dominantSize(p: DocParagraph): number {
  // Size that accounts for the most text volume (not just the single
  // longest run) — robust to mixed runs within a paragraph.
  const bySize = new Map<number, number>();
  let bestSize = 0;
  let bestVolume = 0;
  for (const r of p.runs) {
    if (r.text.trim() === '') continue;
    const v = (bySize.get(r.sizePt) ?? 0) + r.text.length;
    bySize.set(r.sizePt, v);
    if (v > bestVolume) {
      bestVolume = v;
      bestSize = r.sizePt;
    }
  }
  return bestSize;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/* ------------------------------------------------------------------ */
/* DOCX (minimal OOXML) writer                                         */
/* ------------------------------------------------------------------ */

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .split('\u0000')
    .join('');
}

const DOCX_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const DOCX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCX_DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
<w:pPr><w:keepNext/><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
</w:styles>`;

function docxRun(r: DocRun): string {
  const rPr: string[] = [];
  if (r.bold) rPr.push('<w:b/><w:bCs/>');
  if (r.italic) rPr.push('<w:i/><w:iCs/>');
  if (r.sizePt > 0) {
    const half = Math.round(r.sizePt * 2);
    rPr.push(`<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`);
  }
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
  return `<w:r>${rPrXml}<w:t xml:space="preserve">${escXml(r.text)}</w:t></w:r>`;
}

function docxParagraph(p: DocParagraph): string {
  const pPr = p.heading > 0 ? `<w:pPr><w:pStyle w:val="Heading${p.heading}"/></w:pPr>` : '';
  return `<w:p>${pPr}${p.runs.map(docxRun).join('')}</w:p>`;
}

function docxDocumentXml(blocks: DocBlock[]): string {
  const body = blocks
    .map((b) =>
      b.type === 'pagebreak' ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : docxParagraph(b),
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;
}

/** Serialize a document to `.docx` (Office Open XML) bytes. */
export function writeDocx(doc: DocText): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(DOCX_TYPES),
    '_rels/.rels': strToU8(DOCX_ROOT_RELS),
    'word/_rels/document.xml.rels': strToU8(DOCX_DOC_RELS),
    'word/styles.xml': strToU8(DOCX_STYLES),
    'word/document.xml': strToU8(docxDocumentXml(doc.blocks)),
  };
  return zipSync(files, { level: 6 });
}

/* ------------------------------------------------------------------ */
/* ODT (minimal OpenDocument) writer                                   */
/* ------------------------------------------------------------------ */

const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text';

const ODT_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="${ODT_MIMETYPE}"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

function odtRun(r: DocRun): string {
  const attrs: string[] = [];
  if (r.sizePt > 0) attrs.push(`text:font-size="${round1(r.sizePt)}pt"`);
  if (r.bold) attrs.push('text:font-weight="bold"');
  if (r.italic) attrs.push('text:font-style="italic"');
  const attrXml = attrs.length ? ` ${attrs.join(' ')}` : '';
  return `<text:span${attrXml}>${escXml(r.text)}</text:span>`;
}

function odtParagraph(p: DocParagraph): string {
  const style = p.heading > 0 ? ` text:style-name="H${p.heading}"` : '';
  const inner = p.runs.map(odtRun).join('');
  return `<text:p${style}>${inner}</text:p>`;
}

function odtContentXml(doc: DocText): string {
  const body = doc.blocks
    .map((b) => (b.type === 'pagebreak' ? '<text:p text:style-name="PB"/>' : odtParagraph(b)))
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3">
<office:automatic-styles>
<style:style style:name="PB" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>
</office:automatic-styles>
<office:body>
<office:text>${body}</office:text>
</office:body>
</office:document-content>`;
}

const ODT_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3">
<office:styles>
<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0" fo:margin-bottom="0.213cm"/><style:text-properties fo:font-size="11pt"/></style:default-style>
<style:style style:name="H1" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.35cm" fo:margin-bottom="0.15cm" fo:break-before="auto"/><style:text-properties fo:font-size="18pt" fo:font-weight="bold"/><text:outline-level text:value="1"/></style:style>
<style:style style:name="H2" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.28cm" fo:margin-bottom="0.12cm"/><style:text-properties fo:font-size="14pt" fo:font-weight="bold"/><text:outline-level text:value="2"/></style:style>
</office:styles>
</office:document-styles>`;

function odtMetaXml(): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3">
<office:meta><meta:generator>PDFBoogie</meta:generator><dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">${now}</dc:date></office:meta>
</office:document-meta>`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Serialize a document to `.odt` (OpenDocument) bytes.
 *
 * The `mimetype` entry is written **first and stored uncompressed**
 * (fflate `level: 0`), as the ODF spec requires.
 */
export function writeOdt(doc: DocText): Uint8Array {
  const files: Zippable = {
    // Insertion order is preserved → mimetype is the first entry.
    mimetype: [strToU8(ODT_MIMETYPE), { level: 0 }],
    'META-INF/manifest.xml': strToU8(ODT_MANIFEST),
    'content.xml': strToU8(odtContentXml(doc)),
    'styles.xml': strToU8(ODT_STYLES),
    'meta.xml': strToU8(odtMetaXml()),
  };
  return zipSync(files, { level: 6 });
}

/* ------------------------------------------------------------------ */
/* pdfjs extraction + orchestration (browser only)                     */
/* ------------------------------------------------------------------ */

/** Structural type of the pdfjs text items we consume (the root d.ts of
 * pdfjs-dist does not re-export TextItem). */
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

/** Extract raw text items for a page. */
async function extractPage(
  pdf: import('pdfjs-dist').PDFDocumentProxy,
  pageNumber: number,
): Promise<RawTextItem[]> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const items: RawTextItem[] = [];
  for (const it of content.items) {
    // Only real text items (skip TextMarkedContent).
    if (!('str' in it)) continue;
    const item = it as unknown as PdfTextItem;
    if (item.str === '') continue;
    const t = item.transform;
    items.push({
      str: item.str,
      x: t[4] ?? 0,
      y: t[5] ?? 0,
      w: item.width,
      h: item.height,
      size: Math.abs(t[3] ?? item.height),
      fontName: item.fontName ?? '',
      hasEOL: item.hasEOL,
    });
  }
  return items;
}

export interface DocConversionResult {
  format: DocFormat;
  bytes: Uint8Array;
  mime: string;
  ext: string;
  pages: number;
  bodySizePt: number;
  paragraphCount: number;
}

const DOC_MIME: Record<DocFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
};

export { DOC_MIME };

/**
 * Convert a PDF to `.docx` or `.odt` by reconstructing its text flow.
 * Returns the archive bytes for download.
 */
export async function pdfToDoc(
  data: ArrayBuffer | Uint8Array,
  format: DocFormat,
  onProgress: ProgressFn,
  options: DocOptions = {},
): Promise<DocConversionResult> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength === 0) throw new Error('Empty file');

  const pdf = await pdfDocument(bytes);
  try {
    if (pdf.numPages === 0) throw new Error('This PDF has no pages');
    let from = options.from ?? 1;
    let to = options.to ?? pdf.numPages;
    from = Math.min(Math.max(1, from), pdf.numPages);
    to = Math.min(Math.max(1, to), pdf.numPages);
    if (to < from) [from, to] = [to, from];

    const pages: RawTextItem[][] = [];
    for (let p = from; p <= to; p += 1) {
      onProgress(p - from, to - from + 1, `Reading page ${p} of ${to - from + 1}`);
      if (options.op) await options.op.checkpoint();
      else await yieldToBrowser();
      pages.push(await extractPage(pdf, p));
    }

    onProgress(to - from + 1, to - from + 2, 'Reconstructing text…');
    const doc = itemsToBlocks(pages);

    onProgress(to - from + 2, to - from + 3, 'Writing document…');
    const out = format === 'docx' ? writeDocx(doc) : writeOdt(doc);
    await yieldToBrowser();

    const paragraphCount = doc.blocks.filter(
      (b): b is DocParagraph => b.type !== 'pagebreak',
    ).length;

    return {
      format,
      bytes: out,
      mime: DOC_MIME[format],
      ext: format,
      pages: to - from + 1,
      bodySizePt: doc.bodySizePt,
      paragraphCount,
    };
  } finally {
    disposePdf(pdf);
  }
}
