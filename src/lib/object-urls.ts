/**
 * Owned object-URL registry.
 *
 * Every `URL.createObjectURL` a component creates must be paired with a
 * `revokeObjectURL`, including on the paths users rarely take (remove,
 * start-over, route navigation away mid-flow). This registry tracks URLs so
 * `clear()` — called from `onCleanup` or a reset — can revoke exactly the
 * URLs the component owns, with no double-revoke and no leak.
 */
export interface ObjectUrlRegistry {
  /** Create and track a URL for a blob. */
  create: (blob: Blob) => string;
  /** Revoke one tracked URL. Idempotent; unknown URLs are ignored. */
  revoke: (url: string) => void;
  /** Revoke every tracked URL. Idempotent. */
  clear: () => void;
  /** Number of live (not yet revoked) URLs — for tests/benchmarks. */
  size: () => number;
}

export function createObjectUrlRegistry(): ObjectUrlRegistry {
  const live = new Set<string>();

  return {
    create: (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      live.add(url);
      return url;
    },
    revoke: (url: string) => {
      if (!live.delete(url)) return;
      try {
        URL.revokeObjectURL(url);
      } catch {
        // A revoked URL is gone; nothing to do.
      }
    },
    clear: () => {
      for (const url of live) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore — the URL was already gone
        }
      }
      live.clear();
    },
    size: () => live.size,
  };
}
