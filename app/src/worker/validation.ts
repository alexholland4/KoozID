// Request body validation. Small hand-written checks; the API surface is tiny.

import { MAX_SHORT_FIELD, MAX_TEXT_FIELD } from "../shared/limits";
import { FIELD_KEYS, type ItemFields, type ItemStatus, type PhotoSide } from "../shared/types";
import { badRequest } from "./errors";

const LONG_FIELDS = new Set(["description", "visible_text", "notes"]);

function cleanText(v: unknown, key: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw badRequest(`${key} must be a string`);
  // Strip control characters except newline/tab; trim.
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  const max = LONG_FIELDS.has(key) ? MAX_TEXT_FIELD : MAX_SHORT_FIELD;
  if (s.length > max) throw badRequest(`${key} is too long (max ${max} characters)`);
  return s || null;
}

export function parseFields(body: Record<string, unknown>, partial: boolean): Partial<ItemFields> {
  const out: Partial<ItemFields> = {};
  for (const k of FIELD_KEYS) {
    if (!(k in body)) continue;
    const v = cleanText(body[k], k);
    if (k === "description") out.description = v ?? "";
    else out[k] = v;
  }
  if (!partial) {
    for (const k of FIELD_KEYS) if (!(k in out)) (out as Record<string, unknown>)[k] = k === "description" ? "" : null;
  }
  return out;
}

export function parseStatus(v: unknown): ItemStatus | undefined {
  if (v === undefined) return undefined;
  if (v === "active" || v === "needs_review") return v;
  throw badRequest("status must be 'active' or 'needs_review'");
}

export function parseSide(v: unknown): PhotoSide {
  if (v === undefined || v === null || v === "") return "front";
  if (v === "front" || v === "back" || v === "other") return v;
  throw badRequest("side must be front, back or other");
}

export function parseDate(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw badRequest("Dates must be YYYY-MM-DD");
  }
  return v;
}

export function parseItemId(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest("Invalid item id");
  return n;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parsePhotoId(v: unknown): string {
  if (typeof v !== "string" || !UUID.test(v)) throw badRequest("Invalid photo id");
  return v;
}

export function optionalNote(v: unknown): string | null {
  return cleanText(v, "review_note");
}

export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    return b as Record<string, unknown>;
  } catch {
    throw badRequest("Expected a JSON object body");
  }
}
