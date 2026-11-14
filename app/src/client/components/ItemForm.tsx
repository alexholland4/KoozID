import { useState } from "react";
import { BASES, SIZES, type FieldValues, type ItemFields } from "../../shared/types";
import { api } from "../api";
import { useAsync } from "../hooks";
import { fmtDate, Icon } from "./ui";

export type FormValues = ItemFields & { acquired_on: string };

const localToday = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD

// Koozies usually arrive in batches (a gift bag, a trip), so a new one starts with the previous
// one's "where from" details. Only for a few hours, so next week's koozie doesn't inherit them.
const LAST_KEY = "koozid:last-acquisition";
const CARRY_MS = 6 * 60 * 60 * 1000;
type Last = Pick<FormValues, "acquired_from" | "acquired_on" | "city" | "state" | "country" | "size" | "base"> & { at: number };

export function rememberAcquisition(v: FormValues) {
  const last: Last = { acquired_from: v.acquired_from, acquired_on: v.acquired_on, city: v.city, state: v.state, country: v.country, size: v.size, base: v.base, at: Date.now() };
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(last));
  } catch {
    // Storage blocked: nothing to carry over next time.
  }
}

function recall(): Last | null {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "null");
  } catch {
    return null;
  }
}

export const emptyValues = (): FormValues => ({
  description: "",
  color: null,
  size: null,
  base: null,
  acquired_from: null,
  city: null,
  state: null,
  country: null,
  visible_text: null,
  notes: null,
  acquired_on: localToday(),
});

/** Values for a new koozie, with the last save's details carried over where it makes sense. */
export function newValues(): { values: FormValues; carried: boolean } {
  const v = emptyValues();
  const last = recall();
  if (!last) return { values: v, carried: false };
  v.size = last.size;
  v.base = last.base;
  v.country = last.country;
  const recent = Date.now() - last.at < CARRY_MS;
  if (recent) Object.assign(v, { acquired_from: last.acquired_from, acquired_on: last.acquired_on, city: last.city, state: last.state });
  return { values: v, carried: recent && !!(last.acquired_from || last.city) };
}

export const whereLine = (v: Pick<ItemFields, "city" | "state" | "country">) =>
  [v.city, v.state, v.country && !/^(usa?|united states( of america)?)$/i.test(v.country) ? v.country : null].filter(Boolean).join(", ");

/** The collector's spreadsheet columns, in the same order. */
export function ItemForm({
  values,
  onChange,
  descriptionHint,
  carried,
}: {
  values: FormValues;
  onChange: (v: FormValues) => void;
  descriptionHint?: React.ReactNode;
  /** The "where from" fields came from the previous save; show them as one line until changed. */
  carried?: boolean;
}) {
  const known = useAsync(() => api.values(), []);
  const [showWhere, setShowWhere] = useState(!carried);
  const set = (k: keyof FormValues, v: string) => onChange({ ...values, [k]: k === "description" || k === "acquired_on" ? v : v || null });

  const text = (k: "color" | "acquired_from" | "city" | "state" | "country", label: string, placeholder?: string) => (
    <label className="field">
      {label}
      <input className="input" list={`dl-${k}`} value={values[k] ?? ""} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} maxLength={200} autoComplete="off" />
      <Options id={`dl-${k}`} values={known.data?.[k as keyof FieldValues]} />
    </label>
  );

  return (
    <div className="stack">
      <label className="field">
        Description
        <textarea
          className="textarea"
          value={values.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What's printed on it, then the design"
          maxLength={2000}
        />
      </label>
      {descriptionHint}
      {text("color", "Color", "navy blue, white/gold…")}

      <div className="grid-2">
        <Choice label="Size" value={values.size} options={SIZES} onChange={(v) => set("size", v)} />
        <Choice label="Base" value={values.base} options={BASES} onChange={(v) => set("base", v)} />
      </div>

      {showWhere ? (
        <div className="stack">
          {text("acquired_from", "Source", "Gift from…, Purchased at…")}
          <label className="field">
            Date acquired
            <input className="input" type="date" value={values.acquired_on} onChange={(e) => set("acquired_on", e.target.value)} required />
          </label>
          <div className="grid-2">
            {text("city", "City")}
            {text("state", "State")}
          </div>
          {text("country", "Country")}
        </div>
      ) : (
        <div className="carried">
          <div className="grow">
            <div className="small secondary">Same as the last koozie</div>
            <div className="clamp-1">{values.acquired_from ?? "No source"}</div>
            <div className="small secondary clamp-1">{[whereLine(values), fmtDate(values.acquired_on)].filter(Boolean).join(" · ")}</div>
          </div>
          <button type="button" className="btn small" onClick={() => setShowWhere(true)}>
            Change
          </button>
        </div>
      )}

      <details className="more">
        <summary>
          <Icon name="chevron" size={16} /> Printed text and notes
        </summary>
        <div className="stack" style={{ paddingTop: 8 }}>
          <label className="field">
            Printed text
            <textarea className="textarea" style={{ minHeight: 70 }} value={values.visible_text ?? ""} placeholder="Word for word. Helps find duplicates" onChange={(e) => set("visible_text", e.target.value)} maxLength={2000} />
          </label>
          <label className="field">
            Notes
            <textarea className="textarea" style={{ minHeight: 70 }} value={values.notes ?? ""} onChange={(e) => set("notes", e.target.value)} placeholder="Condition, story, anything else" maxLength={2000} />
          </label>
        </div>
      </details>
    </div>
  );
}

function Options({ id, values }: { id: string; values?: string[] }) {
  return (
    <datalist id={id}>
      {values?.map((v) => <option key={v} value={v} />)}
    </datalist>
  );
}

/** A select over the known values that keeps any other value already on the record. */
function Choice({ label, value, options, onChange }: { label: string; value: string | null; options: readonly string[]; onChange: (v: string) => void }) {
  const all = value && !options.includes(value) ? [...options, value] : options;
  return (
    <label className="field">
      {label}
      <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not set</option>
        {all.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SidePicker({ value, onChange }: { value: string; onChange: (v: "front" | "back" | "other") => void }) {
  return (
    <div className="segmented" role="group" aria-label="Which side is this photo?">
      {(["front", "back", "other"] as const).map((s) => (
        <button key={s} type="button" aria-pressed={value === s} onClick={() => onChange(s)}>
          {s === "front" ? "Front" : s === "back" ? "Back" : "Other"}
        </button>
      ))}
    </div>
  );
}
