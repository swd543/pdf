/**
 * Tool chaining: pass a result from one tool straight into the next.
 *
 * A tool that produces a file offers "Continue with …" links in its
 * result card. Clicking one stores the file here (in-memory only —
 * nothing leaves the machine) and navigates to the target tool, which
 * picks the file up on mount and preloads it as its input.
 *
 * One-shot: the first tool that mounts accepts the file and clears it.
 */
import { createSignal, onMount } from 'solid-js';

export interface ChainedFile {
  blob: Blob;
  name: string;
  type: string;
  size: number;
}

let current: ChainedFile | null = null;

/** Store a result for the next tool to pick up. */
export function setChainedFile(file: ChainedFile): void {
  current = file;
}

/** Peek at the pending file (used by tools to decide if they can use it). */
export function getChainedFile(): ChainedFile | null {
  return current;
}

/** Clear the pending file (a consuming tool calls this after prefilling). */
export function clearChainedFile(): void {
  current = null;
}

/**
 * Route helper: if a PDF is pending from a previous tool, consume it,
 * hand it to `consume` (the route's normal file-add path), and expose a
 * dismissible "added from previous step" note.
 */
export function useChainedPdf(consume: (file: File) => void) {
  const [note, setNote] = createSignal('');
  onMount(() => {
    const p = getChainedFile();
    if (!p || p.type !== 'application/pdf') return;
    clearChainedFile();
    setNote(p.name);
    void consume(new File([p.blob], p.name, { type: 'application/pdf' }));
  });
  return { note, dismissNote: () => setNote('') };
}
