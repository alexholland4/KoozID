import { MAX_SHORT_FIELD, MAX_TEXT_FIELD } from "../../shared/limits";
import { BASES, parseItemCode, SIZES, type Suggestion } from "../../shared/types";
import type { MatchResult, RecordOption } from "./types";
import { AiError } from "../errors";

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || /^(null|none|n\/a|unknown)$/i.test(s)) return null;
  return s.slice(0, max);
};

/** Only accept a value from the known list (case-insensitive), returned in its canonical spelling. */
const oneOf = (v: unknown, options: readonly string[]): string | null =>
  typeof v === "string" ? (options.find((o) => o.toLowerCase() === v.trim().toLowerCase()) ?? null) : null;

/** Model output is untrusted input: coerce to the expected shape and length limits. */
export function sanitizeSuggestion(raw: unknown, model: string): Suggestion {
  if (!raw || typeof raw !== "object") throw new AiError("Description model returned no object");
  const r = raw as Record<string, unknown>;
  const description = str(r.description, MAX_TEXT_FIELD);
  if (!description) throw new AiError("Description model returned an empty description");
  return {
    description,
    color: str(r.color, MAX_SHORT_FIELD)?.toLowerCase() ?? null,
    size: oneOf(r.size, SIZES),
    base: oneOf(r.base, BASES),
    visible_text: str(r.visible_text, MAX_TEXT_FIELD),
    model,
  };
}

/** Validate the matcher's answer: ids must be ones we offered, confidence one of three values. */
export function sanitizeMatch(raw: unknown, records: RecordOption[], model: string): MatchResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const offered = new Set(records.map((x) => x.id));
  const toId = (v: unknown) => {
    const n = typeof v === "string" ? parseItemCode(v) : null;
    return n !== null && offered.has(n) ? n : null;
  };
  const itemId = toId(r.match);
  const alternatives = [...new Set((Array.isArray(r.alternatives) ? r.alternatives : []).map(toId))].filter(
    (id): id is number => id !== null && id !== itemId,
  );
  const confidence = r.confidence === "high" || r.confidence === "medium" ? r.confidence : "low";
  let suggestion: Suggestion;
  try {
    suggestion = sanitizeSuggestion(r, model);
  } catch {
    suggestion = { description: "", color: null, size: null, base: null, visible_text: null, model };
  }
  return {
    itemId,
    confidence: itemId === null ? "low" : confidence,
    alternatives: alternatives.slice(0, 3),
    reason: typeof r.reason === "string" ? r.reason.trim().slice(0, 200) : "",
    suggestion,
  };
}
