/**
 * File list for the Merge tool (handoff P2.3).
 *
 * Presentational: one row per accepted file with size/page info and
 * whole-file move/remove controls. Reordering semantics live in the
 * route (and the pure `sequence` transforms).
 */
import { For, Show } from 'solid-js';
import { ArrowDownIcon, ArrowUpIcon, TrashIcon } from '~/components/Icons';
import { humanSize } from '~/lib/files';

export interface MergeFileRow {
  id: string;
  name: string;
  size: number;
  kind: 'pdf' | 'image';
  /** PDF: page count (0 while loading); image: 1. */
  pageCount: number;
  /** Set when the PDF couldn't be rendered (e.g. password-protected). */
  thumbError?: string;
}

interface MergeFileListProps {
  items: () => MergeFileRow[];
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onRemove: (id: string) => void;
  disabled: () => boolean;
}

export function MergeFileList(props: MergeFileListProps) {
  return (
    <Show when={props.items().length > 0}>
      <ul class="filelist" aria-label="Files to merge">
        <For each={props.items()}>
          {(item) => (
            <li class="file-row">
              <span class="file-thumb" />
              <span class="file-name" title={item.name}>
                {item.name}
              </span>
              <span class="file-size">
                {humanSize(item.size)}
                {item.kind === 'pdf' && item.pageCount > 0
                  ? ` · ${item.pageCount} ${item.pageCount === 1 ? 'page' : 'pages'}`
                  : item.kind === 'image'
                    ? ' · image'
                    : ''}
                <Show when={item.thumbError}>
                  <span class="file-warn" role="note">
                    {' '}
                    · {item.thumbError}
                  </span>
                </Show>
              </span>
              <span class="file-actions">
                <button
                  type="button"
                  class="btn btn-sm btn-icon btn-ghost"
                  aria-label={`Move ${item.name} up`}
                  onClick={() => props.onMoveUp(item.id)}
                  disabled={props.disabled()}
                >
                  <ArrowUpIcon />
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-icon btn-ghost"
                  aria-label={`Move ${item.name} down`}
                  onClick={() => props.onMoveDown(item.id)}
                  disabled={props.disabled()}
                >
                  <ArrowDownIcon />
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-icon btn-ghost"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => props.onRemove(item.id)}
                  disabled={props.disabled()}
                >
                  <TrashIcon />
                </button>
              </span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
