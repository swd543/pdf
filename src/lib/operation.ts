/**
 * Operation context: progress + cancellation contract for long-running
 * browser work (handoff §P1.6).
 *
 * Feature logic receives an `OperationContext` and calls `checkpoint()`
 * between units of work (pages, images, files). The context throws an
 * `AbortError` once cancelled; UI code routes that to "stopped", not an
 * error card. PDF.js `RenderTask`s should be cancelled through their own
 * API — checkpoints only cover the JS-side loops.
 */
import type { ProgressFn } from './types';
import { yieldToBrowser } from './types';

export interface OperationContext {
  /** Aborts when the user cancels (clear, replace file, navigate away). */
  signal: AbortSignal;
  /** Progress reporter (same shape as the routes' `setProgress` payloads). */
  progress: ProgressFn;
  /**
   * Give the event loop a turn and throw `AbortError` if cancelled.
   * Await it between pages/images/files in every long loop.
   */
  checkpoint: () => Promise<void>;
}

/** Controls returned alongside the context so UI code can cancel. */
export interface OperationHandle {
  op: OperationContext;
  /** Cancel the operation (idempotent; safe to call multiple times). */
  cancel: () => void;
}

export function createOperation(
  progress: ProgressFn,
  externalSignal?: AbortSignal,
): OperationHandle {
  const controller = new AbortController();
  const signal = externalSignal ?? controller.signal;
  if (externalSignal) externalSignal.addEventListener('abort', () => controller.abort());

  const checkpoint = async (): Promise<void> => {
    if (signal.aborted) throw new DOMException('Operation cancelled', 'AbortError');
    await yieldToBrowser();
    if (signal.aborted) throw new DOMException('Operation cancelled', 'AbortError');
  };

  return {
    op: { signal, progress, checkpoint },
    cancel: () => controller.abort(),
  };
}

/** True when an error is a cancellation (vs. a real failure). */
export function isAbortError(err: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}
