// Import planning: map spreadsheet columns to KoozID fields and pair rows with photo files.
// Pure functions (no DOM, no network) so they're unit-tested and reusable by scripts.

import { parseLooseDate } from "./csv";
import { parseItemCode, type ItemFields, type PhotoSide } from "./types";

export type Target = keyof ItemFields | "external_ref" | "photos" | "acquired_on";

// Order matters: each column is claimed by the first target whose pattern matches it.
export const TARGETS: { key: Target; label: string; guess: RegExp }[] = [
  { key: "external_ref", label: "Koozie ID", guess: /^(id|#|no\.?|num(ber)?|item ?(id|no|#)|koozie ?(id|#|no)|ref(erence)?)$/i },
  { key: "description", label: "Description", guess: /desc|details|name|title/i },
  { key: "photos", label: "Photo file name(s)", guess: /photo|image|picture|pic|file/i },
  { key: "acquired_on", label: "Date acquired", guess: /date|added|acquired|when/i },
  { key: "acquired_from", label: "Source", guess: /source|from|origin|gift|purchased/i },
  { key: "color", label: "Color", guess: /colou?r/i },
  { key: "size", label: "Size", guess: /size/i },
  { key: "base", label: "Base", guess: /^base$|base|style|construction/i },
  { key: "city", label: "City", guess: /city|town/i },
  { key: "state", label: "State", guess: /^state$|state|province|region/i },
  { key: "country", label: "Country", guess: /country|nation/i },
  { key: "visible_text", label: "Printed text", guess: /text|wording|slogan|says/i },
  { key: "notes", label: "Notes", guess: /note|comment|remark|condition/i },
];

/** Spreadsheet tallies (e.g. "Total Koozies", "World Record") that sit beside the data, not part of it. */
const SUMMARY_HEADER = /^(total|count|world ?record|record|goal|target|remaining|left|to go)\b/i;

/** Columns that aren't item data: blank headers and summary tallies. Never mapped, never stored. */
export function ignoredColumns(headers: string[]): number[] {
  return headers.flatMap((h, i) => (!h.trim() || SUMMARY_HEADER.test(h.trim()) ? [i] : []));
}

/**
 * A collection goal written beside the data, e.g. a "World Record" or "Goal" column holding 3715 in
 * its first row. Returns the number so the import can offer to set it as the goal.
 */
export function findGoal(headers: string[], rows: string[][]): { column: string; value: number } | null {
  const col = headers.findIndex((h) => /world ?record|goal|target/i.test(h));
  if (col < 0) return null;
  for (const r of rows.slice(0, 20)) {
    const n = Number((r[col] ?? "").replace(/[,\s]/g, ""));
    if (Number.isInteger(n) && n > 0) return { column: headers[col], value: n };
  }
  return null;
}

export type Mapping = Partial<Record<Target, number>>; // target -> column index

export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  const used = new Set<number>(ignoredColumns(headers));
  for (const t of TARGETS) {
    const idx = headers.findIndex((h, i) => !used.has(i) && t.guess.test(h.trim()));
    if (idx >= 0) {
      m[t.key] = idx;
      used.add(idx);
    }
  }
  return m;
}

/** Lowercase file name without directory and extension. */
export const baseName = (name: string) =>
  name
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .trim()
    .toLowerCase();

export const sideFromName = (name: string): PhotoSide => (/(^|[^a-z])(back|rear|reverse|b)$/i.test(baseName(name)) ? "back" : /side|other|alt/i.test(baseName(name)) ? "other" : "front");

export interface PlanFile<F> {
  file: F;
  name: string;
  side: PhotoSide;
}

export interface PlannedRow<F> {
  row: number; // 1-based spreadsheet row (header = row 1)
  externalRef: string | null;
  /** Catalogue number parsed from the ID (K-0042 -> 42), kept if it's free. */
  number: number | null;
  fields: ItemFields;
  acquiredOn: string | null;
  extra: Record<string, string>;
  files: PlanFile<F>[];
  missing: string[]; // photo names listed in the sheet that weren't found
  warnings: string[];
}

export interface Plan<F> {
  rows: PlannedRow<F>[];
  unusedFiles: string[];
  duplicateRefs: string[];
  /** Rows with nothing but an ID (pre-numbered blank lines), left out of `rows`. */
  blankRows: number;
  /** Headers of columns that are skipped entirely (blank headers, summary tallies). */
  ignored: string[];
}

const MAX_PHOTOS = 8;

/**
 * Build an import plan. Photos are matched (case-insensitive, extension ignored) by:
 *   1. names listed in the mapped "photos" column (separated by ; , | or newlines), else
 *   2. the row's ID: "123.jpg", "123_back.jpg", "123-2.jpg", "123 front.jpg" all match ID 123.
 */
export function buildPlan<F>(headers: string[], rows: string[][], mapping: Mapping, files: { file: F; name: string }[]): Plan<F> {
  const byBase = new Map<string, { file: F; name: string }[]>();
  for (const f of files) {
    const b = baseName(f.name);
    byBase.set(b, [...(byBase.get(b) ?? []), f]);
  }
  const used = new Set<string>();
  const seenRefs = new Map<string, number>();
  const duplicateRefs: string[] = [];
  const ignored = ignoredColumns(headers);
  const mappedCols = new Set([...Object.values(mapping), ...ignored]);
  const get = (r: string[], t: Target) => (mapping[t] !== undefined ? (r[mapping[t]!] ?? "").trim() : "");

  const planned = rows.map((r, i): PlannedRow<F> | null => {
    const warnings: string[] = [];
    const ref = get(r, "external_ref") || null;
    if (ref) {
      if (seenRefs.has(ref)) duplicateRefs.push(ref);
      seenRefs.set(ref, i);
    }
    const fields: ItemFields = {
      description: get(r, "description").slice(0, 2000),
      color: get(r, "color") || null,
      size: get(r, "size") || null,
      base: get(r, "base") || null,
      acquired_from: get(r, "acquired_from") || null,
      city: get(r, "city") || null,
      state: get(r, "state") || null,
      country: get(r, "country") || null,
      visible_text: get(r, "visible_text") || null,
      notes: get(r, "notes") || null,
    };
    const rawDate = get(r, "acquired_on");
    const acquiredOn = rawDate ? parseLooseDate(rawDate) : null;
    const extra: Record<string, string> = {};
    headers.forEach((h, ci) => {
      if (!mappedCols.has(ci) && (r[ci] ?? "").trim()) extra[h || `Column ${ci + 1}`] = r[ci].trim();
    });
    if (rawDate && !acquiredOn) {
      warnings.push(`Unrecognised date "${rawDate}" (kept in extra columns)`);
      extra[headers[mapping.acquired_on!] || "Date"] = rawDate;
    }

    const matched: { file: F; name: string }[] = [];
    const missing: string[] = [];
    const listed = get(r, "photos")
      .split(/[;,|\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (listed.length) {
      for (const n of listed) {
        const hit = byBase.get(baseName(n));
        if (hit) matched.push(...hit);
        else missing.push(n);
      }
    } else if (ref) {
      const key = ref.toLowerCase();
      const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([ _\\-.](.*))?$`);
      for (const [b, fs] of byBase) if (b === key || pattern.test(b)) matched.push(...fs);
    }
    const unique = [...new Map(matched.map((m) => [m.name, m])).values()].sort((a, b) => sideRank(a.name) - sideRank(b.name) || a.name.localeCompare(b.name));
    if (unique.length > MAX_PHOTOS) warnings.push(`${unique.length} photos matched; only the first ${MAX_PHOTOS} will be imported`);
    const chosen = unique.slice(0, MAX_PHOTOS);
    // A pre-numbered row with nothing filled in yet isn't a koozie.
    const hasContent = Object.values(fields).some(Boolean) || rawDate || Object.keys(extra).length || listed.length;
    if (!hasContent && !chosen.length) return null;
    chosen.forEach((m) => used.add(m.name));
    if (!fields.description && !chosen.length) warnings.push("Row has no description and no photo");
    return {
      row: i + 2,
      externalRef: ref,
      number: ref ? parseItemCode(ref) : null,
      fields,
      acquiredOn,
      extra,
      files: chosen.map((m) => ({ ...m, side: sideFromName(m.name) })),
      missing,
      warnings,
    };
  });
  const kept = planned.filter((r): r is PlannedRow<F> => r !== null);
  return {
    rows: kept,
    unusedFiles: files.filter((f) => !used.has(f.name)).map((f) => f.name),
    duplicateRefs: [...new Set(duplicateRefs)],
    blankRows: planned.length - kept.length,
    ignored: ignored.map((i) => headers[i] || `Column ${i + 1}`),
  };
}

const sideRank = (n: string) => ({ front: 0, other: 1, back: 2 })[sideFromName(n)];

/** No spreadsheet: one item per photo group ("123.jpg" + "123_back.jpg" become one item). */
export function photosOnlyPlan<F>(files: { file: F; name: string }[]): Plan<F> {
  const groups = new Map<string, { file: F; name: string }[]>();
  for (const f of files) {
    const key = baseName(f.name).replace(/([ _\-.](front|back|rear|reverse|side|other|alt|f|b|\d))$/i, "");
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const rows = [...groups.entries()].map(([key, fs], i): PlannedRow<F> => ({
    row: i + 1,
    externalRef: key,
    number: null,
    fields: { description: "", color: null, size: null, base: null, acquired_from: null, city: null, state: null, country: null, visible_text: null, notes: null },
    acquiredOn: null,
    extra: {},
    files: fs
      .sort((a, b) => sideRank(a.name) - sideRank(b.name) || a.name.localeCompare(b.name))
      .slice(0, MAX_PHOTOS)
      .map((f) => ({ ...f, side: sideFromName(f.name) })),
    missing: [],
    warnings: [],
  }));
  return { rows, unusedFiles: [], duplicateRefs: [], blankRows: 0, ignored: [] };
}
