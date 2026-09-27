/**
 * Shared single-PDF input presentation (handoff P2.1).
 *
 * Dumb presentational component for the four single-PDF tools (Compress,
 * Combine, PDF-to-image, Sign): chain note, drop zone, and the
 * file row with a remove button. Tool-specific validation, PDF opening,
 * phases and processing stay in the route (P2.2: no universal tool hook).
 */
import { Show } from 'solid-js';
import { humanSize } from '~/lib/files';
import type { FileItem } from '~/lib/types';
import { ChainNote } from './ChainBar';
import { TrashIcon } from './Icons';
import { DropZone } from './Shell';

export interface SinglePdfInputProps {
  /** Reactive file accessor (null while empty). */
  file: () => FileItem | null;
  /**
   * Optional page count shown next to the size (hidden while 0).
   * Pass a function — the component is presentational and re-renders on
   * dependency change.
   */
  pageCount?: () => number;
  /**
   * Drop-zone visibility, decided entirely by the route (e.g.
   * `!file() || phase() === 'empty'` in the current tools).
   */
  showDrop: () => boolean;
  dropTitle: string;
  dropSubtitle: string;
  /** Drop zone busy state (spinner), e.g. while opening/processing. */
  busy?: boolean;
  /** Disable the remove button (e.g. while processing). */
  disableRemove?: boolean;
  note: () => string;
  dismissNote: () => void;
  onFiles: (files: File[]) => void;
  onClear: () => void;
}

export function SinglePdfInput(props: SinglePdfInputProps) {
  return (
    <>
      <ChainNote note={props.note} dismiss={props.dismissNote} />
      <Show when={props.showDrop()}>
        <DropZone
          accept="application/pdf,.pdf"
          title={props.dropTitle}
          subtitle={props.dropSubtitle}
          busy={props.busy}
          onFiles={props.onFiles}
        />
      </Show>
      <Show when={props.file()}>
        <div class="file-row" style="margin-bottom: 0.5rem">
          <span class="file-name" title={props.file()!.name}>
            {props.file()!.name}
          </span>
          <span class="file-size">
            {humanSize(props.file()!.size)}
            {props.pageCount &&
              (props.pageCount() > 0
                ? ` · ${props.pageCount()} ${props.pageCount() === 1 ? 'page' : 'pages'}`
                : '')}
          </span>
          <span class="file-actions">
            <button
              type="button"
              class="btn btn-sm btn-icon btn-ghost"
              aria-label="Remove PDF"
              onClick={props.onClear}
              disabled={props.disableRemove}
            >
              <TrashIcon />
            </button>
          </span>
        </div>
      </Show>
    </>
  );
}
