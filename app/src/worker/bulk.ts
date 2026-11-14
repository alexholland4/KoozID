// One-time bulk photo import: upload a folder of photos, let the AI pick which written record each
// one shows, then a person confirms each suggestion. Until confirmed, a photo is an unclaimed scan
// with a row in bulk_photos (which also exempts it from the 24h scan cleanup). A row can carry the
// koozie's back as well; it's matched together with the front and saved with it.

import { MAX_PHOTOS_PER_ITEM } from "../shared/limits";
import type { BulkPhoto, BulkQueue, Item, ItemFields, MatchConfidence, Suggestion } from "../shared/types";
import { itemCode } from "../shared/types";
import type { RecordOption } from "./ai/types";
import { attachScanToItem, checkQuota, saveScanAsItem, storePhoto, type Deps } from "./catalog";
import { getPhoto, nowIso, photosForItem, summariesByIds } from "./db";
import { AiError, badRequest, HttpError, notFound } from "./errors";
import { deletePhotoObjects } from "./images";

interface BulkRow {
  photo_id: string;
  back_photo_id: string | null;
  status: BulkPhoto["status"];
  item_id: number | null;
  confidence: MatchConfidence | null;
  alternatives: string | null;
  reason: string | null;
  suggestion: string | null;
  error: string | null;
  skipped_at: string | null;
  original_name: string | null;
}

/** Most records the matcher sees in one prompt; the oldest unphotographed records come first. */
const MAX_RECORDS = 1500;

export async function bulkUpload(
  d: Deps,
  form: { full: unknown; thumb: unknown; name: string | null; back?: { full: unknown; thumb: unknown; name: string | null } },
): Promise<{ photo_id: string; status: "queued" | "duplicate" }> {
  const photo = await storePhoto(d, form.full, form.thumb, form.name);
  // The same file uploaded twice (a re-run, or a photo already in the collection) is dropped.
  const dup = await d.db
    .prepare(
      `SELECT p.id FROM photos p LEFT JOIN items i ON i.id = p.item_id
       WHERE p.sha256 = ? AND p.id != ?
         AND ((p.item_id IS NOT NULL AND i.deleted_at IS NULL) OR p.id IN (SELECT photo_id FROM bulk_photos)
              OR p.id IN (SELECT back_photo_id FROM bulk_photos WHERE back_photo_id IS NOT NULL))
       LIMIT 1`,
    )
    .bind(photo.sha256, photo.id)
    .first<{ id: string }>();
  if (dup) {
    await discardPhoto(d, photo.id);
    return { photo_id: dup.id, status: "duplicate" };
  }
  const back = form.back ? await storePhoto(d, form.back.full, form.back.thumb, form.back.name) : null;
  await d.db
    .prepare("INSERT INTO bulk_photos (photo_id, back_photo_id, created_at) VALUES (?, ?, ?)")
    .bind(photo.id, back?.id ?? null, nowIso())
    .run();
  return { photo_id: photo.id, status: "queued" };
}

async function getRow(d: Deps, photoId: string): Promise<BulkRow> {
  const row = await d.db
    .prepare("SELECT b.*, p.original_name FROM bulk_photos b JOIN photos p ON p.id = b.photo_id WHERE b.photo_id = ?")
    .bind(photoId)
    .first<BulkRow>();
  if (!row) throw notFound("That photo is no longer waiting for review");
  return row;
}

/** Ask the AI which unphotographed record this photo shows. Safe to re-run. */
export async function bulkMatch(d: Deps, photoId: string): Promise<BulkPhoto> {
  await getRow(d, photoId);
  const photo = (await getPhoto(d.db, photoId))!;
  const { results: records } = await d.db
    .prepare(
      `SELECT i.id, i.description, i.color, i.size, i.base FROM items i
       WHERE i.deleted_at IS NULL AND i.description != '' AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.item_id = i.id)
       ORDER BY i.id LIMIT ?`,
    )
    .bind(MAX_RECORDS)
    .all<Omit<RecordOption, "code">>();
  const options: RecordOption[] = records.map((r) => ({ ...r, code: itemCode(r.id) }));

  const read = async (key: string) => {
    const obj = await d.bucket.get(key);
    if (!obj) throw new HttpError(409, "photo_missing", "The stored photo file is missing");
    return new Uint8Array(await obj.arrayBuffer());
  };
  const row = await getRow(d, photoId);
  const backPhoto = row.back_photo_id ? await getPhoto(d.db, row.back_photo_id) : null;

  try {
    await checkQuota(d, "reindex");
    const [front, back] = await Promise.all([read(photo.full_key), backPhoto ? read(backPhoto.full_key) : Promise.resolve(undefined)]);
    const m = await d.matcher.match(front, options, { hint: photo.original_name ?? "", back });
    await d.db
      .prepare(
        `UPDATE bulk_photos SET status = 'suggested', item_id = ?, confidence = ?, alternatives = ?, reason = ?, suggestion = ?, error = NULL
         WHERE photo_id = ?`,
      )
      .bind(m.itemId, m.confidence, JSON.stringify(m.alternatives), m.reason, JSON.stringify(m.suggestion), photoId)
      .run();
  } catch (e) {
    // Rate limits and the daily cap leave the photo pending so the client can retry later.
    if (e instanceof AiError && (e.kind === "rate_limited" || e.kind === "quota" || e.kind === "unavailable")) {
      throw new HttpError(e.kind === "rate_limited" ? 429 : 503, e.kind, e.message.slice(0, 200));
    }
    if (e instanceof HttpError) throw e;
    // Anything else: still reviewable, just without a suggestion.
    await d.db
      .prepare("UPDATE bulk_photos SET status = 'failed', error = ? WHERE photo_id = ?")
      .bind(String((e as Error).message).slice(0, 300), photoId)
      .run();
  }
  return (await toBulkPhotos(d, [await getRow(d, photoId)]))[0];
}

async function toBulkPhotos(d: Deps, rows: BulkRow[]): Promise<BulkPhoto[]> {
  const alts = rows.map((r) => (r.alternatives ? (JSON.parse(r.alternatives) as number[]) : []));
  const ids = [...new Set(rows.flatMap((r, i) => [...(r.item_id ? [r.item_id] : []), ...alts[i]]))];
  const sums = await summariesByIds(d.db, ids);
  return rows.map((r, i) => ({
    photo_id: r.photo_id,
    back_photo_id: r.back_photo_id,
    status: r.status,
    original_name: r.original_name,
    item: r.item_id ? (sums.get(r.item_id) ?? null) : null,
    confidence: r.confidence,
    alternatives: alts[i].map((id) => sums.get(id)).filter((s) => !!s),
    reason: r.reason,
    suggestion: r.suggestion ? (JSON.parse(r.suggestion) as Suggestion) : null,
    error: r.error,
    skipped: !!r.skipped_at,
  }));
}

/**
 * The review queue: most confident suggestions first, so the easy ones go quickly; skipped photos
 * go last. `pending` returns photos that still need matching instead.
 */
export async function bulkQueue(d: Deps, opts: { pending?: boolean; limit?: number }): Promise<BulkQueue> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 500);
  const where = opts.pending ? "b.status = 'pending'" : "b.status != 'pending'";
  const [rows, counts] = await d.db.batch([
    d.db
      .prepare(
        `SELECT b.*, p.original_name FROM bulk_photos b JOIN photos p ON p.id = b.photo_id WHERE ${where}
         ORDER BY b.skipped_at IS NOT NULL, b.skipped_at,
                  CASE WHEN b.item_id IS NULL THEN 3 WHEN b.confidence = 'high' THEN 0 WHEN b.confidence = 'medium' THEN 1 ELSE 2 END,
                  b.created_at
         LIMIT ?`,
      )
      .bind(limit),
    d.db.prepare("SELECT status, COUNT(*) AS n FROM bulk_photos GROUP BY status"),
  ]);
  const c = { pending: 0, suggested: 0, failed: 0 };
  for (const r of counts.results as { status: keyof typeof c; n: number }[]) c[r.status] = r.n;
  return { items: await toBulkPhotos(d, rows.results as BulkRow[]), counts: c };
}

/** "Correct" / "Pick another": attach the photo to an existing record. */
export async function bulkAccept(d: Deps, photoId: string, itemId: number): Promise<Item> {
  const row = await getRow(d, photoId);
  const existing = await photosForItem(d.db, itemId);
  const adding = row.back_photo_id ? 2 : 1;
  if (existing.length + adding > MAX_PHOTOS_PER_ITEM) throw badRequest(`That koozie already has ${existing.length} photos`);
  let item: Item;
  if (row.back_photo_id) {
    // A front/back pair: saved as such, unless the record already has photos.
    await attachScanToItem(d, itemId, photoId, existing.length ? "other" : "front", { deferIndex: true });
    item = await attachScanToItem(d, itemId, row.back_photo_id, "back", { deferIndex: true });
  } else {
    // First photo of a record is its front; a second one for the same koozie is most likely the back.
    item = await attachScanToItem(d, itemId, photoId, existing.length ? "back" : "front", { deferIndex: true });
  }
  await d.db.prepare("DELETE FROM bulk_photos WHERE photo_id = ?").bind(photoId).run();
  return item;
}

/** "Not in the list": save the photo as a new koozie. */
export async function bulkCreate(d: Deps, photoId: string, fields: ItemFields, acquiredOn?: string): Promise<Item> {
  const row = await getRow(d, photoId);
  let item = await saveScanAsItem(d, { scanId: photoId, fields, status: "active", reviewNote: null, side: "front", acquiredOn, deferIndex: true });
  if (row.back_photo_id) item = await attachScanToItem(d, item.id, row.back_photo_id, "back", { deferIndex: true });
  await d.db.prepare("DELETE FROM bulk_photos WHERE photo_id = ?").bind(photoId).run();
  return item;
}

export async function bulkSkip(d: Deps, photoId: string) {
  await getRow(d, photoId);
  await d.db.prepare("UPDATE bulk_photos SET skipped_at = ? WHERE photo_id = ?").bind(nowIso(), photoId).run();
}

export async function bulkDiscard(d: Deps, photoId: string) {
  await getRow(d, photoId);
  await discardPhoto(d, photoId);
}

async function discardPhoto(d: Deps, photoId: string) {
  const photo = await getPhoto(d.db, photoId);
  if (!photo || photo.item_id !== null) return;
  const row = await d.db.prepare("SELECT back_photo_id FROM bulk_photos WHERE photo_id = ?").bind(photoId).first<{ back_photo_id: string | null }>();
  const back = row?.back_photo_id ? await getPhoto(d.db, row.back_photo_id) : null;
  const gone = [photo, ...(back && back.item_id === null ? [back] : [])];
  await d.db.batch([
    d.db.prepare("DELETE FROM bulk_photos WHERE photo_id = ?").bind(photoId),
    ...gone.map((p) => d.db.prepare("DELETE FROM photos WHERE id = ? AND item_id IS NULL").bind(p.id)),
  ]);
  await deletePhotoObjects(d.bucket, gone.flatMap((p) => [p.full_key, p.thumb_key]));
}
