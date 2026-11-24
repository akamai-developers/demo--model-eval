import { Check, ChevronDown } from "lucide-react";
import { compact, cx } from "../lib/format";
import { maker, ModelMark, useModels } from "../lib/models";

export function ModelSelect({ value, onChange, disabled, otherModels }: {
  value: string; onChange: (id: string) => void; disabled?: boolean; otherModels: string[];
}) {
  const { chat } = useModels();
  return (
    <label className="model-select">
      <span className="model-select-button" aria-hidden="true">
        <ModelMark id={value} size={24} />
        <span className="model-select-name">{value || "Choose a model"}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
      <select aria-label={`Choose model, currently ${value}`} disabled={disabled} value={value}
        onChange={event => onChange(event.target.value)}>
        {value && !chat.some(model => model.id === value) && <option value={value}>{value}</option>}
        {chat.map(model => <option key={model.id} value={model.id} disabled={model.id !== value && otherModels.includes(model.id)}>
          {model.id} · {maker(model.id)}{model.max_output_tokens ? ` · up to ${compact(model.max_output_tokens)} output tokens` : ""}
        </option>)}
      </select>
    </label>
  );
}

/** Pick several chat models. Every model is a toggle. */
export function ModelChips({
  value,
  onChange,
  max,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  max?: number;
}) {
  const { chat } = useModels();
  const full = max != null && value.length >= max;
  return (
    <div className="chips" role="group" aria-label="Models">
      {chat.map((model) => {
        const on = value.includes(model.id);
        return (
          <button
            key={model.id}
            type="button"
            aria-pressed={on}
            disabled={!on && full}
            title={!on && full ? `Up to ${max} models` : maker(model.id)}
            className={cx("chip", on && "is-on")}
            onClick={() => onChange(on ? value.filter((id) => id !== model.id) : [...value, model.id])}
          >
            <span className="chip-check" aria-hidden="true">
              {on && <Check size={12} strokeWidth={3} />}
            </span>
            <span className="mono">{model.id}</span>
          </button>
        );
      })}
    </div>
  );
}
