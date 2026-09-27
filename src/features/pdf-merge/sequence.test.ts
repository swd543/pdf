import { describe, expect, it } from 'vitest';
import { appendPages, moveBlockTo, moveFile, nudgeBlock, selectOnTileClick } from './sequence';

const order = (ids: string[]) => ids.map((id) => ({ id, file: 'f', page: Number(id) || 1 }));

describe('selectOnTileClick', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('plain click selects the tile', () => {
    const r = selectOnTileClick(ids, [], 'b', false, null);
    expect(r.ids).toEqual(['b']);
    expect(r.anchor).toBe('b');
  });

  it('ctrl/cmd click toggles while preserving the rest', () => {
    let r = selectOnTileClick(ids, [], 'a', false, null);
    expect(r.ids).toEqual(['a']);
    r = selectOnTileClick(ids, r.ids, 'c', false, r.anchor);
    expect(r.ids).toEqual(['a', 'c']);
    r = selectOnTileClick(ids, r.ids, 'a', false, r.anchor);
    expect(r.ids).toEqual(['c']);
  });

  it('shift+click adds the anchor→target range', () => {
    let r = selectOnTileClick(ids, [], 'a', false, null);
    r = selectOnTileClick(ids, r.ids, 'c', true, r.anchor);
    expect(r.ids).toEqual(['a', 'b', 'c']);
    // extending the other way
    r = selectOnTileClick(ids, r.ids, 'd', true, 'b');
    expect(r.ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shift with a missing anchor falls back to toggle', () => {
    const r = selectOnTileClick(ids, ['b'], 'c', true, 'zzz');
    expect(r.ids).toEqual(['b', 'c']);
    expect(r.anchor).toBe('c');
  });
});

describe('nudgeBlock', () => {
  it('moves the block left, filling the vacated slot', () => {
    const o = order(['a', 'b', 'c', 'd']);
    const r = nudgeBlock(o, new Set(['c']), 'c', -1);
    expect(r!.map((x) => x.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves a multi-tile block as a unit right', () => {
    const o = order(['a', 'b', 'c', 'd', 'e']);
    const r = nudgeBlock(o, new Set(['b', 'c']), 'b', 1);
    expect(r!.map((x) => x.id)).toEqual(['a', 'd', 'b', 'c', 'e']);
  });

  it('is a no-op at the edges', () => {
    const o = order(['a', 'b']);
    expect(nudgeBlock(o, new Set(['a']), 'a', -1)).toBeNull();
    expect(nudgeBlock(o, new Set(['b']), 'b', 1)).toBeNull();
  });

  it('includes the clicked tile when it is not selected', () => {
    const o = order(['a', 'b', 'c']);
    const r = nudgeBlock(o, new Set<string>(), 'a', 1);
    expect(r!.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('moveBlockTo', () => {
  it('moves a block to the head / middle / tail', () => {
    const o = order(['a', 'b', 'c', 'd']);
    expect(moveBlockTo(o, new Set(['c']), 0).map((x) => x.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveBlockTo(o, new Set(['c']), 1).map((x) => x.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveBlockTo(o, new Set(['c']), 99).map((x) => x.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('keeps the block internal order and clamps', () => {
    const o = order(['a', 'b', 'c', 'd']);
    expect(moveBlockTo(o, new Set(['b', 'c']), -1).map((x) => x.id)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('moveFile', () => {
  it('moves a file down, keeping its pages contiguous', () => {
    const fileOrder = ['f1', 'f2', 'f3'];
    const seq = [
      { id: 'f1::1', file: 'f1', page: 1 },
      { id: 'f2::1', file: 'f2', page: 1 },
      { id: 'f2::2', file: 'f2', page: 2 },
      { id: 'f3::1', file: 'f3', page: 1 },
    ];
    const r = moveFile(fileOrder, seq, 'f1', 1)!;
    expect(r.fileOrder).toEqual(['f2', 'f1', 'f3']);
    expect(r.order.map((x) => x.id)).toEqual(['f2::1', 'f2::2', 'f1::1', 'f3::1']);
  });

  it('moves a file up, before the anchor file first page', () => {
    const fileOrder = ['f1', 'f2', 'f3'];
    const seq = [
      { id: 'f1::1', file: 'f1', page: 1 },
      { id: 'f2::1', file: 'f2', page: 1 },
      { id: 'f3::1', file: 'f3', page: 1 },
      { id: 'f3::2', file: 'f3', page: 2 },
    ];
    const r = moveFile(fileOrder, seq, 'f3', -1)!;
    expect(r.fileOrder).toEqual(['f1', 'f3', 'f2']);
    expect(r.order.map((x) => x.id)).toEqual(['f1::1', 'f3::1', 'f3::2', 'f2::1']);
  });

  it('is a no-op at the edges and for unknown files', () => {
    const fileOrder = ['f1'];
    const seq = [{ id: 'f1::1', file: 'f1', page: 1 }];
    expect(moveFile(fileOrder, seq, 'f1', -1)).toBeNull();
    expect(moveFile(fileOrder, seq, 'f1', 1)).toBeNull();
    expect(moveFile(fileOrder, seq, 'zzz', 1)).toBeNull();
  });
});

describe('appendPages', () => {
  it('appends 1-based page entries with stable ids', () => {
    const r = appendPages(order(['a']), 'f2', 3);
    expect(r.map((x) => x.id)).toEqual(['a', 'f2::1', 'f2::2', 'f2::3']);
  });
});
