/**
 * Pure selection and reordering transforms for the Merge page strip
 * (handoff P2.3). No DOM, no signals — unit testable in isolation.
 */

export interface SeqEntry {
  id: string;
  file: string;
  page: number;
}

/**
 * Tile click/tap selection:
 * - Shift + existing anchor: add the anchor→target range (ids in
 *   `order` positions) to the current selection.
 * - Plain or Ctrl/⌘: toggle the tile, keep the rest.
 *
 * Returns the new selection array (insertion order preserved) and the
 * new anchor. When Shift is held but the range is invalid (anchor or
 * target not in the order) the plain toggle semantics apply.
 */
export function selectOnTileClick(
  order: string[],
  current: string[],
  id: string,
  shiftKey: boolean,
  anchor: string | null,
): { ids: string[]; anchor: string } {
  const cur = new Set(current);
  if (shiftKey && anchor) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (const x of order.slice(lo, hi + 1)) cur.add(x);
      return { ids: [...cur], anchor };
    }
  }
  if (cur.has(id)) cur.delete(id);
  else cur.add(id);
  return { ids: [...cur], anchor: id };
}

/**
 * Nudge a block of tiles (the selection, or just `tileId`) one slot in
 * `dir` direction. The block moves as a unit; the tile just outside it
 * takes the vacated slot. Returns the new order, or null when the nudge
 * is a no-op (block at an edge).
 */
export function nudgeBlock(
  order: SeqEntry[],
  block: Set<string>,
  tileId: string,
  dir: -1 | 1,
): SeqEntry[] | null {
  const sel = new Set(block);
  if (!sel.has(tileId)) sel.add(tileId);
  const list = [...order];
  let min = -1;
  let max = -1;
  list.forEach((x, i) => {
    if (sel.has(x.id)) {
      if (min < 0) min = i;
      max = i;
    }
  });
  if (min < 0) return null;
  if (dir === -1 && min === 0) return null;
  if (dir === 1 && max === list.length - 1) return null;
  const next = [...list];
  if (dir === -1) {
    // The slot before the block moves to after it; once that element is
    // removed the block itself has shifted left by one, so "after the
    // block" is index `max` in the shortened list.
    const [el] = next.splice(min - 1, 1);
    next.splice(max, 0, el!);
  } else {
    const [el] = next.splice(max + 1, 1);
    next.splice(min, 0, el!);
  }
  return next;
}

/**
 * Move a block to `insertAt` (position among the *rest* — non-block
 * tiles). The block keeps its internal order; the rest keep theirs.
 */
export function moveBlockTo(order: SeqEntry[], block: Set<string>, insertAt: number): SeqEntry[] {
  const drag = order.filter((s) => block.has(s.id));
  const rest = order.filter((s) => !block.has(s.id));
  const idx = Math.max(0, Math.min(insertAt, rest.length));
  return [...rest.slice(0, idx), ...drag, ...rest.slice(idx)];
}

/**
 * Move a whole file's pages (in their current relative order) one file
 * position in `dir` direction, keeping them contiguous. `fileOrder` is
 * the current file list; returns the new file order plus the page-level
 * seq order, or null when the move is a no-op.
 */
export function moveFile(
  fileOrder: string[],
  order: SeqEntry[],
  fileId: string,
  dir: -1 | 1,
): { fileOrder: string[]; order: SeqEntry[] } | null {
  const list = [...fileOrder];
  const from = list.findIndex((x) => x === fileId);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= list.length) return null;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item!);

  const block = order.filter((x) => x.file === fileId);
  const rest = order.filter((x) => x.file !== fileId);
  if (block.length === 0) return null;
  // The neighbour the file lands next to after the move (the moved file
  // itself sits at index `to` in the spliced list).
  const anchorId = dir === 1 ? list[to - 1]! : list[to + 1]!;
  let insertAt: number;
  if (dir === 1) {
    // after the anchor file's last page
    let last = -1;
    rest.forEach((x, i) => {
      if (x.file === anchorId) last = i;
    });
    insertAt = last < 0 ? rest.length : last + 1;
  } else {
    // before the anchor file's first page
    insertAt = rest.findIndex((x) => x.file === anchorId);
    if (insertAt < 0) insertAt = 0;
  }
  return {
    fileOrder: list,
    order: [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)],
  };
}

/**
 * Insert a new file's page entries at the end of the seq (used when a
 * file's pages finish loading).
 */
export function appendPages(order: SeqEntry[], fileId: string, pageCount: number): SeqEntry[] {
  const pages: SeqEntry[] = Array.from({ length: pageCount }, (_, i) => ({
    id: `${fileId}::${i + 1}`,
    file: fileId,
    page: i + 1,
  }));
  return [...order, ...pages];
}
