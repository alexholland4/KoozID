// D1 data access. All SQL lives here.

import type { FieldValues, Item, ItemFields, ItemStatus, ItemSummary, PhotoInfo, PhotoSide, Stats } from "../shared/types";
import { itemCode } from "../shared/types";

export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

export interface ItemRow extends ItemFields {
  id: number;
  status: ItemStatus;
  review_note: string | null;
  acquired_on: string;
  origin: Item["origin"];
  external_ref: string | null;
  extra_json: string | null;
  is_demo: number;
  back_same: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PhotoRow {
  id: string;
  item_id: number | null;
  side: PhotoSide;
  position: number;
  full_key: string;
  thumb_key: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  original_name: string | null;
  embedding: ArrayBuffer | Uint8Array | number[] | null;
  embedding_model: string | null;
  indexed: number;
  embed_error: string | null;
  created_at: string;
}

// Summary rows carry the primary photo id and a photo count via correlated subqueries.
const SUMMARY_COLS = `i.id, i.status, i.description, i.color, i.size, i.base, i.acquired_from, i.city, i.state, i.country, i.acquired_on,
  (SELECT p.id FROM photos p WHERE p.item_id = i.id ORDER BY p.position, p.created_at LIMIT 1) AS thumb_photo_id,
  (SELECT COUNT(*) FROM photos p WHERE p.item_id = i.id) AS photo_count`;

type SummaryRow = Omit<ItemSummary, "code">;
const toSummary = (r: SummaryRow): ItemSummary => ({ ...r, code: itemCode(r.id) });

export async function summariesByIds(db: D1Database, ids: number[]): Promise<Map<number, ItemSummary>> {
  const out = new Map<number, ItemSummary>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare(`SELECT ${SUMMARY_COLS} FROM items i WHERE i.deleted_at IS NULL AND i.id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<SummaryRow>();
  for (const r of results) out.set(r.id, toSummary(r));
  return out;
}

/** Text columns the collection can be sorted by (the spreadsheet view's headers). */
const TEXT_SORTS = {
  description: "i.description",
  source: "i.acquired_from",
  color: "i.color",
  size: "i.size",
  base: "i.base",
  city: "i.city",
  state: "i.state",
  country: "i.country",
} as const;
export const SORT_KEYS = ["acquired", "id", "updated", "photos", ...(Object.keys(TEXT_SORTS) as (keyof typeof TEXT_SORTS)[])] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export async function listItems(
  db: D1Database,
  opts: {
    q?: string;
    status?: ItemStatus | "all";
    noPhoto?: boolean;
    sort?: SortKey;
    order?: "asc" | "desc";
    offset?: number;
    limit?: number;
    deleted?: boolean;
    /** Only what guests may see: counted, non-demo koozies. */
    publicOnly?: boolean;
    /** "Source" (who gave it / where bought), case-insensitive; a leaderboard group name covers its members. */
    source?: string;
    /** Acquired on this day (YYYY-MM-DD). */
    on?: string;
  },
): Promise<{ items: ItemSummary[]; total: number }> {
  const where: string[] = [opts.deleted ? "i.deleted_at IS NOT NULL" : "i.deleted_at IS NULL"];
  if (opts.publicOnly) where.push("i.status = 'active'", "i.is_demo = 0");
  const binds: unknown[] = [];
  if (opts.status && opts.status !== "all") {
    where.push("i.status = ?");
    binds.push(opts.status);
  }
  if (opts.on) {
    where.push("i.acquired_on = ?");
    binds.push(opts.on);
  }
  if (opts.source) {
    // The exact source, or every source combined under that name on the leaderboard.
    where.push(
      "(i.acquired_from = ? COLLATE NOCASE OR EXISTS (SELECT 1 FROM source_groups g WHERE g.source = i.acquired_from AND g.contributor = ? COLLATE NOCASE))",
    );
    binds.push(opts.source, opts.source);
  }
  if (opts.noPhoto) where.push("NOT EXISTS (SELECT 1 FROM photos p WHERE p.item_id = i.id)");
  // Every whitespace-separated term must appear somewhere (AND), case-insensitive.
  const terms = (opts.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const t of terms) {
    where.push("i.search_text LIKE ? ESCAPE '\\'");
    binds.push(`%${t.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
  }
  const order = opts.order === "asc" ? "ASC" : "DESC";
  const key = opts.sort ?? "acquired";
  let orderBy: string;
  if (key in TEXT_SORTS) {
    // Blank values last in either direction, then case-insensitive.
    const col = TEXT_SORTS[key as keyof typeof TEXT_SORTS];
    orderBy = `(${col} IS NULL OR ${col} = '') ASC, ${col} COLLATE NOCASE ${order}`;
  } else {
    orderBy = `${{ acquired: "i.acquired_on", id: "i.id", updated: "i.updated_at", photos: "photo_count" }[key as "acquired"]} ${order}`;
  }
  const limit = Math.min(Math.max(opts.limit ?? 48, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const whereSql = where.join(" AND ");
  const [rows, count] = await db.batch([
    db
      .prepare(`SELECT ${SUMMARY_COLS} FROM items i WHERE ${whereSql} ORDER BY ${orderBy}, i.id ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset),
    db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${whereSql}`).bind(...binds),
  ]);
  return {
    items: (rows.results as SummaryRow[]).map(toSummary),
    total: (count.results[0] as { n: number }).n,
  };
}

export async function getItemRow(db: D1Database, id: number): Promise<ItemRow | null> {
  return db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<ItemRow>();
}

export async function getItem(db: D1Database, id: number): Promise<Item | null> {
  const row = await getItemRow(db, id);
  if (!row) return null;
  const photos = await photosForItem(db, id);
  return rowToItem(row, photos);
}

export function rowToItem(row: ItemRow, photos: PhotoRow[]): Item {
  let extra: Record<string, string> | null = null;
  try {
    extra = row.extra_json ? JSON.parse(row.extra_json) : null;
  } catch {
    extra = null;
  }
  return {
    id: row.id,
    code: itemCode(row.id),
    status: row.status,
    review_note: row.review_note,
    description: row.description,
    color: row.color,
    size: row.size,
    base: row.base,
    acquired_from: row.acquired_from,
    city: row.city,
    state: row.state,
    country: row.country,
    visible_text: row.visible_text,
    notes: row.notes,
    acquired_on: row.acquired_on,
    origin: row.origin,
    external_ref: row.external_ref,
    extra,
    is_demo: !!row.is_demo,
    back_same: !!row.back_same,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    photos: photos.map(toPhotoInfo),
  };
}

export const toPhotoInfo = (p: PhotoRow): PhotoInfo => ({
  id: p.id,
  side: p.side,
  position: p.position,
  width: p.width,
  height: p.height,
  indexed: !!p.indexed,
  embed_error: p.embed_error,
});

export async function photosForItem(db: D1Database, itemId: number): Promise<PhotoRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM photos WHERE item_id = ? ORDER BY position, created_at")
    .bind(itemId)
    .all<PhotoRow>();
  return results;
}

export async function getPhoto(db: D1Database, id: string): Promise<PhotoRow | null> {
  return db.prepare("SELECT * FROM photos WHERE id = ?").bind(id).first<PhotoRow>();
}

export interface NewItem {
  fields: ItemFields;
  status: ItemStatus;
  reviewNote?: string | null;
  acquiredOn?: string;
  origin: Item["origin"];
  /** Explicit catalogue number (keeps a spreadsheet's numbering). Must be unused. */
  id?: number;
  externalRef?: string | null;
  extraJson?: string | null;
  isDemo?: boolean;
}

/**
 * INSERT statement for a new item (RETURNING id). `guard` is an optional SQL condition; when it is
 * false nothing is inserted, which lets callers make "create item + claim photo" atomic in a batch.
 */
export function insertItemStatement(db: D1Database, n: NewItem, guard?: { sql: string; binds: unknown[] }): D1PreparedStatement {
  const ts = nowIso();
  const f = n.fields;
  return db
    .prepare(
      `INSERT INTO items (id, status, description, color, size, base, acquired_from, city, state, country, visible_text, notes,
         review_note, acquired_on, origin, external_ref, extra_json, is_demo, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard?.sql ?? "1"} RETURNING id`,
    )
    .bind(
      n.id ?? null,
      n.status,
      f.description,
      f.color,
      f.size,
      f.base,
      f.acquired_from,
      f.city,
      f.state,
      f.country,
      f.visible_text,
      f.notes,
      n.reviewNote ?? null,
      n.acquiredOn ?? ts.slice(0, 10),
      n.origin,
      n.externalRef ?? null,
      n.extraJson ?? null,
      n.isDemo ? 1 : 0,
      ts,
      ts,
      ...(guard?.binds ?? []),
    );
}

export async function updateItem(
  db: D1Database,
  id: number,
  patch: Partial<ItemFields> & { status?: ItemStatus; review_note?: string | null; acquired_on?: string; back_same?: boolean },
) {
  const row = await getItemRow(db, id);
  if (!row || row.deleted_at) return null;
  const merged = { ...row, ...patch };
  const ts = nowIso();
  await db
    .prepare(
      `UPDATE items SET status = ?, description = ?, color = ?, size = ?, base = ?, acquired_from = ?, city = ?, state = ?, country = ?,
         visible_text = ?, notes = ?, review_note = ?, acquired_on = ?, back_same = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      merged.status,
      merged.description,
      merged.color,
      merged.size,
      merged.base,
      merged.acquired_from,
      merged.city,
      merged.state,
      merged.country,
      merged.visible_text,
      merged.notes,
      merged.status === "active" ? null : merged.review_note,
      merged.acquired_on,
      merged.back_same ? 1 : 0,
      ts,
      id,
    )
    .run();
  return getItem(db, id);
}

export async function stats(db: D1Database): Promise<Omit<Stats, "recent" | "goal">> {
  const r = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND status = 'active') AS total,
         (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND status = 'needs_review') AS needs_review,
         (SELECT COUNT(*) FROM items WHERE deleted_at IS NOT NULL) AS deleted,
         (SELECT COUNT(*) FROM items i WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.item_id = i.id)) AS no_photo,
         (SELECT COUNT(*) FROM bulk_photos WHERE status != 'pending') AS bulk_review,
         (SELECT COUNT(*) FROM contributions WHERE status = 'new') AS offers,
         (SELECT COUNT(*) FROM photos p JOIN items i ON i.id = p.item_id WHERE i.deleted_at IS NULL) AS photos,
         (SELECT COUNT(*) FROM photos p JOIN items i ON i.id = p.item_id WHERE i.deleted_at IS NULL AND p.indexed = 0) AS pending_index`,
    )
    .first<Omit<Stats, "recent" | "goal">>();
  return r!;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string | null) {
  if (value === null) await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  else await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/** Distinct values already used in the free-text "where from" fields, most common first. */
export async function fieldValues(db: D1Database): Promise<FieldValues> {
  const cols = ["color", "acquired_from", "city", "state", "country"] as const;
  const res = await db.batch(
    cols.map((c) =>
      db.prepare(
        `SELECT ${c} AS v FROM items WHERE deleted_at IS NULL AND ${c} IS NOT NULL AND ${c} != ''
         GROUP BY ${c} ORDER BY COUNT(*) DESC, MAX(id) DESC LIMIT 300`,
      ),
    ),
  );
  return Object.fromEntries(cols.map((c, i) => [c, (res[i].results as { v: string }[]).map((r) => r.v)])) as unknown as FieldValues;
}

/** Atomically bump today's usage counter for `kind` and return the new value. */
export async function bumpUsage(db: D1Database, kind: string): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO ai_usage (day, kind, count) VALUES (?, ?, 1)
       ON CONFLICT (day, kind) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(today(), kind)
    .first<{ count: number }>();
  return r!.count;
}
