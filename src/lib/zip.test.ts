import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { makeZip, ZipStream } from '~/lib/zip';

describe('makeZip', () => {
  it('produces a valid ZIP with the expected entries', () => {
    const out = makeZip([
      { path: 'a.txt', data: new TextEncoder().encode('alpha') },
      { path: 'sub/b.txt', data: new TextEncoder().encode('beta') },
    ]);
    expect(out[0]).toBe(0x50); // 'P'
    expect(out[1]).toBe(0x4b); // 'K'
    const entries = unzipSync(out);
    expect(Object.keys(entries).sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect(new TextDecoder().decode(entries['a.txt']!)).toBe('alpha');
    expect(new TextDecoder().decode(entries['sub/b.txt']!)).toBe('beta');
  });
});

describe('ZipStream', () => {
  it('produces a valid archive from incremental adds (store mode)', async () => {
    const stream = new ZipStream();
    stream.add('a.txt', new TextEncoder().encode('alpha'));
    stream.add('b.txt', new TextEncoder().encode('beta'));
    const out = await stream.finish();

    const entries = unzipSync(out);
    expect(Object.keys(entries).sort()).toEqual(['a.txt', 'b.txt']);
    expect(new TextDecoder().decode(entries['a.txt']!)).toBe('alpha');
    expect(new TextDecoder().decode(entries['b.txt']!)).toBe('beta');
  });

  it('matches makeZip content for identical entries', async () => {
    const a = new TextEncoder().encode('one');
    const b = new TextEncoder().encode('two');
    const stream = new ZipStream();
    stream.add('1.bin', a);
    stream.add('2.bin', b);
    const streamed = await stream.finish();
    const sync = makeZip([
      { path: '1.bin', data: a },
      { path: '2.bin', data: b },
    ]);
    expect(unzipSync(streamed)).toEqual(unzipSync(sync));
  });

  it('finishing with no entries yields an empty archive', async () => {
    const out = await new ZipStream().finish();
    expect(out[0]).toBe(0x50);
    expect(Object.keys(unzipSync(out))).toEqual([]);
  });
});
