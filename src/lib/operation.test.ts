import { describe, expect, it, vi } from 'vitest';
import { createOperation, isAbortError } from '~/lib/operation';

describe('createOperation', () => {
  it('checkpoint() resolves while not cancelled and reports progress', async () => {
    const progress = vi.fn();
    const { op, cancel } = createOperation(progress);
    expect(op.progress).toBe(progress);
    await op.checkpoint(); // does not throw
    cancel();
    expect(op.signal.aborted).toBe(true);
  });

  it('checkpoint() throws AbortError once cancelled', async () => {
    const { op, cancel } = createOperation(() => undefined);
    cancel();
    await expect(op.checkpoint()).rejects.toThrow('Operation cancelled');
    const err = await op.checkpoint().catch((e) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it('cancel() is idempotent', () => {
    const { cancel } = createOperation(() => undefined);
    cancel();
    cancel();
    expect(true).toBe(true);
  });

  it('propagates an external signal abort', async () => {
    const ac = new AbortController();
    const { op } = createOperation(() => undefined, ac.signal);
    expect(op.signal.aborted).toBe(false);
    ac.abort();
    expect(op.signal.aborted).toBe(true);
    await expect(op.checkpoint()).rejects.toThrow();
  });
});

describe('isAbortError', () => {
  it('recognises AbortError shapes', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    const e = new Error('x');
    e.name = 'AbortError';
    expect(isAbortError(e)).toBe(true);
    expect(isAbortError(new Error('nope'))).toBe(false);
    expect(isAbortError('nope')).toBe(false);
  });
});
