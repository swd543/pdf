/**
 * ZIP archive helpers built on fflate (tiny, zero-dependency, WASM-free).
 * Used by pdf-to-image for multi-page exports.
 *
 * Two APIs:
 *  - `makeZip` — synchronous, for small archives (tests, single images).
 *  - `ZipStream` — incremental writer (handoff P0.5): each page is added as
 *    it renders, so the tool never holds every page at once. Image entries
 *    are already compressed, so they pass through as STORE (no deflation,
 *    no blocking main-thread compression pass).
 */
import { Zip, ZipPassThrough, zipSync } from 'fflate';

export interface ZipEntry {
  /** Path inside the archive, e.g. "page-001.png". */
  path: string;
  data: Uint8Array;
}

/** Build a ZIP archive from entries (synchronous — small inputs only). */
export function makeZip(entries: ZipEntry[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.path] = entry.data;
  }
  // fflate accepts a plain object keyed by archive path.
  return zipSync(files, { level: 6 });
}

function concatU8(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Incremental ZIP writer. Add entries as they become available, then call
 * `finish()`. Errors surface from `finish()` (or from `add` if the archive
 * was already finalized).
 */
export class ZipStream {
  private zip: Zip;
  private chunks: Uint8Array[] = [];
  private failErr: unknown = null;

  constructor() {
    this.zip = new Zip((err, chunk, final) => {
      if (err) {
        this.failErr = err;
      } else if (chunk.length > 0) {
        this.chunks.push(chunk);
      }
      if (final) {
        // `finish()` is called by the owner; chunks are complete here.
      }
    });
  }

  /**
   * Add one entry. Entries are stored uncompressed (STORE) — the image
   * formats we archive (PNG/JPEG/WebP) are already compressed, so
   * deflating them again would only burn CPU and freeze the UI.
   */
  add(path: string, data: Uint8Array): void {
    if (this.failErr) throw this.failErr;
    const file = new ZipPassThrough(path);
    this.zip.add(file); // must precede push — wires the output handler
    file.push(data, true);
  }

  /** Stop accepting entries and resolve the full archive bytes. */
  finish(): Promise<Uint8Array> {
    this.zip.end();
    if (this.failErr) return Promise.reject(this.failErr);
    return Promise.resolve(concatU8(this.chunks));
  }
}
