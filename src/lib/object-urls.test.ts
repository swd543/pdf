import { afterEach, describe, expect, it, vi } from 'vitest';
import { createObjectUrlRegistry } from '~/lib/object-urls';

/** Node's URL has no createObjectURL/revokeObjectURL — stub just those. */
function stubUrl(): { created: string[]; revoked: string[] } {
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  vi.stubGlobal(
    'URL',
    class URL {
      static createObjectURL(_blob: Blob): string {
        n += 1;
        const url = `blob:fake-${n}`;
        created.push(url);
        return url;
      }
      static revokeObjectURL(url: string): void {
        revoked.push(url);
      }
    } as unknown as typeof URL,
  );
  return { created, revoked };
}

afterEach(() => vi.unstubAllGlobals());

describe('createObjectUrlRegistry', () => {
  it('tracks and revokes each URL exactly once', () => {
    const { created, revoked } = stubUrl();
    const reg = createObjectUrlRegistry();

    const a = reg.create(new Blob(['a']));
    const b = reg.create(new Blob(['b']));
    expect(reg.size()).toBe(2);

    reg.revoke(a);
    expect(reg.size()).toBe(1);
    expect(revoked).toEqual([a]);

    // second revoke of the same URL must be a no-op
    reg.revoke(a);
    expect(revoked).toEqual([a]);

    reg.clear();
    expect(reg.size()).toBe(0);
    expect(revoked).toEqual([a, b]);
    expect(created).toEqual([a, b]);
  });

  it('clear() is idempotent', () => {
    const { revoked } = stubUrl();
    const reg = createObjectUrlRegistry();
    reg.create(new Blob(['a']));
    reg.clear();
    reg.clear();
    expect(reg.size()).toBe(0);
    expect(revoked.length).toBe(1);
  });

  it('revoke() of an unknown URL is a no-op', () => {
    const { revoked } = stubUrl();
    const reg = createObjectUrlRegistry();
    reg.revoke('blob:never-tracked');
    expect(revoked).toEqual([]);
    expect(reg.size()).toBe(0);
  });
});
