/**
 * File helpers: human-readable sizes and binary loading.
 * Pure functions — safe in Node (vitest) and the browser.
 */

/** Format a byte count as a short human-readable string (e.g. "3.2 MB"). */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Read a File as a copy of its bytes (detached ArrayBuffer). */
export async function readFileBytes(file: File): Promise<ArrayBuffer> {
  const buffer = await file.arrayBuffer();
  // Some engines return a "view" ArrayBuffer that is only valid until the
  // next GC; copy so PDF libraries can keep a stable reference.
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(new Uint8Array(buffer));
  return copy.buffer;
}

/** Stable-ish unique id for list items (no crypto needed). */
let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** Strip a path if the browser handed us one (Safari drag & drop). */
export function cleanFileName(name: string): string {
  return name.replace(/^.*[\\/]/, '') || 'file';
}

/** Percent saved when going from `before` bytes to `after` bytes. */
export function percentSaved(before: number, after: number): number {
  if (before <= 0) return 0;
  return Math.round(((before - after) / before) * 100);
}
