/**
 * Form fields panel for Sign & Fill (handoff P2.3).
 *
 * Presentational: renders each AcroForm field with the right input
 * control and an Apply button. Value reads/writes go through the route's
 * signals via the get/set callbacks; the route owns the fill operation.
 */
import { For, Show } from 'solid-js';
import type { FieldInfo } from '~/features/pdf-sign/logic';

interface FormPanelProps {
  fields: () => FieldInfo[];
  getFieldValue: (name: string) => string | boolean;
  setFieldValue: (name: string, value: string | boolean) => void;
  onApply: () => void;
  /** Disable the Apply button (e.g. while not ready). */
  applyDisabled: () => boolean;
}

export function FormPanel(props: FormPanelProps) {
  return (
    <div class="panel" style="margin-top: 1rem">
      <div class="panel-title">Form fields</div>
      <div class="panel-body" style="max-height: 340px; overflow-y: auto">
        <For each={props.fields()}>
          {(f: FieldInfo) => (
            <div class="field">
              <span title={f.name}>{f.name}</span>
              <Show when={f.type === 'text' || f.type === 'date'}>
                <input
                  type="text"
                  disabled={f.type === 'date'}
                  placeholder={
                    f.type === 'date' ? 'Date fields are not fillable in this build' : 'Value'
                  }
                  value={
                    typeof props.getFieldValue(f.name) === 'string'
                      ? (props.getFieldValue(f.name) as string)
                      : ''
                  }
                  onInput={(e) => props.setFieldValue(f.name, e.currentTarget.value)}
                />
              </Show>
              <Show when={f.type === 'checkbox'}>
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(props.getFieldValue(f.name))}
                    onChange={(e) => props.setFieldValue(f.name, e.currentTarget.checked)}
                  />
                  <span class="knob" />
                  <span>Checked</span>
                </label>
              </Show>
              <Show when={f.type === 'radio' || f.type === 'dropdown'}>
                <select
                  value={String(props.getFieldValue(f.name))}
                  onChange={(e) => props.setFieldValue(f.name, e.currentTarget.value)}
                >
                  <option value="">—</option>
                  {(f.choices ?? []).map((choice) => (
                    <option value={choice}>{choice}</option>
                  ))}
                </select>
              </Show>
            </div>
          )}
        </For>
        <button
          type="button"
          class="btn btn-primary btn-block"
          style="margin-top: 0.8rem"
          onClick={props.onApply}
          disabled={props.applyDisabled()}
        >
          Apply form fill
        </button>
      </div>
    </div>
  );
}
