// Application logic: scanning, saving, indexing, deleting and importing koozies.
// Route handlers stay thin; everything that touches more than one store lives here.

import { CANDIDATE_LIMIT, MAX_PHOTOS_PER_ITEM } from "../shared/limits";
import type {
  Candidate,
  DescribeResponse,
  Item,
  ItemFields,
  ItemStatus,
  PhotoSide,
  ReindexResponse,
  ScanResponse,
  SearchStatus,
} from "../shared/types";
import type { Describer, Embedder, Matcher } from "./ai/types";
import {
  bumpUsage,
  getItem,
  getItemRow,
  getPhoto,
  insertItemStatement,
  nowIso,
  photosForItem,
  summariesByIds,
  type PhotoRow,
} from "./db";
import type { Config } from "./env";
import { AiError, badRequest, HttpError, notFound } from "./errors";
import { deletePhotoObjects, photoKeys, putPhoto, sha256Hex, validateJpeg } from "./images";
import type { VectorIndex } from "./search";
import { band, rankItems } from "./search/rank";
import { fromBlob, toBlob } from "./vectors";

export interface Deps {
  db: D1Database;
  bucket: R2Bucket;
  cfg: Config;
  embedder: Embedder;
  describer: Describer;
  matcher: Matcher;
  index: VectorIndex;
  /** Defers non-critical work past the response (ctx.waitUntil). */
  defer: (p: Promise<unknown>) => void;
}

const SCAN_TTL_MS = 24 * 60 * 60 * 1000;
/** Deleted koozies stay restorable this long, then they and their photos are erased. */
export const TRASH_DAYS = 30;
const PHOTO_TOP_K = 20;

export async function checkQuota(d: Deps, kind: "interactive" | "reindex") {
  const n = await bumpUsage(d.db, kind);
  const cap = kind === "interactive" ? d.cfg.aiDailyLimit : d.cfg.aiDailyReindexLimit;
  if (n > cap) throw new AiError(`Daily AI limit reached (${cap}). Resets at midnight UTC.`, "quota");
}

// ----------------------------------------------------------------------------- photos

interface StoredPhoto {
  id: string;
  sha256: string;
}

export async function storePhoto(d: Deps, fullFile: unknown, thumbFile: unknown, originalName: string | null): Promise<StoredPhoto & { bytes: Uint8Array }> {
  const [full, thumb] = await Promise.all([validateJpeg(fullFile, "full"), validateJpeg(thumbFile, "thumb")]);
  const sha = await sha256Hex(full.bytes);
  const id = crypto.randomUUID();
  const keys = await putPhoto(d.bucket, id, full.bytes, thumb.bytes, sha);
  await d.db
    .prepare(
      `INSERT INTO photos (id, item_id, side, position, full_key, thumb_key, width, height, bytes, sha256, original_name, created_at)
       VALUES (?, NULL, 'front', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, keys.full, keys.thumb, full.width, full.height, full.bytes.length, sha, originalName?.slice(0, 255) ?? null, nowIso())
    .run();
  return { id, sha256: sha, bytes: full.bytes };
}

async function readFull(d: Deps, photo: PhotoRow): Promise<Uint8Array> {
  const obj = await d.bucket.get(photo.full_key);
  if (!obj) throw new HttpError(409, "photo_missing", "The stored photo file is missing; re-upload it");
  return new Uint8Array(await obj.arrayBuffer());
}

async function embedAndStore(d: Deps, photoId: string, bytes: Uint8Array): Promise<Float32Array> {
  try {
    const vec = await d.embedder.embedImage(bytes);
    await d.db
      .prepare("UPDATE photos SET embedding = ?, embedding_model = ?, embed_error = NULL WHERE id = ?")
      .bind(toBlob(vec), d.embedder.modelId, photoId)
      .run();
    return vec;
  } catch (e) {
    await d.db.prepare("UPDATE photos SET embed_error = ? WHERE id = ?").bind(String((e as Error).message).slice(0, 300), photoId).run();
    throw e;
  }
}

/** Put photos of live items into the vector index, using stored embeddings. */
async function indexStoredPhotos(d: Deps, photos: PhotoRow[]): Promise<number> {
  const ready = photos.filter((p) => p.item_id !== null && p.embedding && p.embedding_model === d.embedder.modelId);
  if (!ready.length) return 0;
  await d.index.upsert(ready.map((p) => ({ photoId: p.id, itemId: p.item_id!, vector: fromBlob(p.embedding!) })));
  await d.db
    .prepare(`UPDATE photos SET indexed = 1 WHERE id IN (${ready.map(() => "?").join(",")})`)
    .bind(...ready.map((p) => p.id))
    .run();
  return ready.length;
}

/** Best-effort: index a photo right after it joins an item. Failures leave it pending for reindex. */
export async function indexPhotoSoon(d: Deps, photoId: string, quota: "interactive" | "reindex" = "interactive") {
  try {
    let photo = await getPhoto(d.db, photoId);
    if (!photo || photo.item_id === null) return;
    if (!photo.embedding || photo.embedding_model !== d.embedder.modelId) {
      await checkQuota(d, quota);
      await embedAndStore(d, photoId, await readFull(d, photo));
      photo = await getPhoto(d.db, photoId);
    }
    if (photo) await indexStoredPhotos(d, [photo]);
  } catch (e) {
    console.warn("indexing deferred for", photoId, (e as Error).message);
  }
}

// ----------------------------------------------------------------------------- scan

export async function searchByVector(d: Deps, vec: Float32Array, excludePhotoId?: string): Promise<Candidate[]> {
  const hits = (await d.index.query(vec, PHOTO_TOP_K)).filter((h) => h.photoId !== excludePhotoId);
  if (!hits.length) return [];
  // Map photo ids to live items via D1 (authoritative); stale vectors are dropped.
  const { results } = await d.db
    .prepare(
      `SELECT p.id, p.item_id, p.side FROM photos p JOIN items i ON i.id = p.item_id
       WHERE i.deleted_at IS NULL AND p.id IN (${hits.map(() => "?").join(",")})`,
    )
    .bind(...hits.map((h) => h.photoId))
    .all<{ id: string; item_id: number; side: PhotoSide }>();
  const photoToItem = new Map(results.map((r) => [r.id, r.item_id]));
  const sideOf = new Map(results.map((r) => [r.id, r.side]));
  const ranked = rankItems(hits, photoToItem, CANDIDATE_LIMIT);
  const summaries = await summariesByIds(d.db, ranked.map((r) => r.itemId));
  return ranked
    .filter((r) => summaries.has(r.itemId))
    .map((r) => ({
      item: summaries.get(r.itemId)!,
      score: Math.round(r.score * 1000) / 1000,
      band: band(r.score, d.cfg.matchStrong, d.cfg.matchPossible),
      matched_photo_id: r.photoId,
      matched_side: sideOf.get(r.photoId) ?? "front",
    }));
}

export async function createScan(
  d: Deps,
  form: { full: unknown; thumb: unknown; originalName?: string | null; search: boolean },
): Promise<ScanResponse> {
  d.defer(cleanupScans(d));
  const photo = await storePhoto(d, form.full, form.thumb, form.originalName ?? null);

  const exact = await d.db
    .prepare(
      `SELECT p.item_id FROM photos p JOIN items i ON i.id = p.item_id
       WHERE p.sha256 = ? AND p.id != ? AND i.deleted_at IS NULL LIMIT 1`,
    )
    .bind(photo.sha256, photo.id)
    .first<{ item_id: number }>();
  const exactItem = exact ? ((await summariesByIds(d.db, [exact.item_id])).get(exact.item_id) ?? null) : null;

  const res: ScanResponse = { scan_id: photo.id, search_status: "skipped", candidates: [], exact_photo_item: exactItem, unphotographed: 0 };
  if (!form.search) return res;
  const bare = await d.db
    .prepare("SELECT COUNT(*) AS n FROM items i WHERE i.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.item_id = i.id)")
    .first<{ n: number }>();
  res.unphotographed = bare?.n ?? 0;

  let status: SearchStatus = "ok";
  try {
    await checkQuota(d, "interactive");
    const vec = await embedAndStore(d, photo.id, photo.bytes);
    res.candidates = await searchByVector(d, vec, photo.id);
    if (!res.candidates.length) {
      const any = await d.db.prepare("SELECT 1 FROM photos WHERE indexed = 1 LIMIT 1").first();
      status = any ? "ok" : "empty";
    }
  } catch (e) {
    status = e instanceof AiError && e.kind === "unavailable" ? "unavailable" : "failed";
    res.search_error = (e as Error).message.slice(0, 200);
    console.error("scan search failed", res.search_error);
  }
  res.search_status = status;
  return res;
}

const STOP = new Set([
  "the", "and", "for", "with", "koozie", "from", "your", "this", "that", "est", "since", "inc", "llc",
  "logo", "text", "blue", "green", "black", "white", "yellow", "orange", "purple", "pink", "grey", "gray", "brown",
  "navy", "light", "dark", "background", "design", "top", "bottom", "side", "sides", "photo", "front", "back", "words",
]);

/** Distinctive words the model read on the koozie, used for a cheap text cross-check. */
export function textTerms(s: { description: string; visible_text: string | null }): string[] {
  // Printed text is the strongest signal; the description adds names the model paraphrased.
  const words = `${s.visible_text ?? ""} ${s.visible_text ? "" : s.description}`
    .toLowerCase()
    .split(/[^a-z0-9&']+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 4);
}

export async function describeScan(d: Deps, photoId: string, backId?: string): Promise<DescribeResponse> {
  const photo = await getPhoto(d.db, photoId);
  if (!photo) throw notFound("Scan not found");
  const back = backId ? await getPhoto(d.db, backId) : null;
  try {
    await checkQuota(d, "interactive");
    const [front, backBytes] = await Promise.all([readFull(d, photo), back ? readFull(d, back) : Promise.resolve(undefined)]);
    const suggestion = await d.describer.describe(front, backBytes);
    const terms = textTerms(suggestion);
    let text_matches: DescribeResponse["text_matches"] = [];
    if (terms.length) {
      // Rank by how many distinctive terms each item contains.
      const score = terms.map(() => "(i.search_text LIKE ?)").join(" + ");
      const { results } = await d.db
        .prepare(
          `SELECT i.id, ${score} AS hits FROM items i WHERE i.deleted_at IS NULL AND (${score}) > 0
           ORDER BY hits DESC, i.id DESC LIMIT ?`,
        )
        .bind(...terms.map((t) => `%${t}%`), ...terms.map((t) => `%${t}%`), CANDIDATE_LIMIT)
        .all<{ id: number; hits: number }>();
      const sums = await summariesByIds(d.db, results.map((r) => r.id));
      text_matches = results.map((r) => sums.get(r.id)!).filter(Boolean);
    }
    return { suggestion, text_matches };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("describe failed", (e as Error).message);
    return { suggestion: null, error: (e as Error).message.slice(0, 200), text_matches: [] };
  }
}

// ----------------------------------------------------------------------------- save

async function claimableScan(d: Deps, photoId: string): Promise<PhotoRow> {
  const photo = await getPhoto(d.db, photoId);
  if (!photo) throw notFound("Scan not found or expired; please scan again");
  return photo;
}

export async function saveScanAsItem(
  d: Deps,
  input: { scanId: string; fields: ItemFields; status: ItemStatus; reviewNote: string | null; side: PhotoSide; acquiredOn?: string; deferIndex?: boolean },
): Promise<Item> {
  const photo = await claimableScan(d, input.scanId);
  if (photo.item_id !== null) {
    // Idempotent: a retried/double-tapped save returns the item created the first time.
    const existing = await getItem(d.db, photo.item_id);
    if (existing) return existing;
  }
  // Create the item and claim the photo in one transaction; the INSERT is guarded so a
  // concurrent save of the same scan cannot create a second item.
  const insert = insertItemStatement(
    d.db,
    { fields: input.fields, status: input.status, reviewNote: input.reviewNote, acquiredOn: input.acquiredOn, origin: "scan" },
    { sql: "EXISTS (SELECT 1 FROM photos WHERE id = ? AND item_id IS NULL)", binds: [photo.id] },
  );
  const claim = d.db
    .prepare("UPDATE photos SET item_id = last_insert_rowid(), side = ?, position = 0 WHERE id = ? AND item_id IS NULL AND changes() = 1")
    .bind(input.side, photo.id);
  const [ins] = await d.db.batch<{ id: number }>([insert, claim]);
  const newId = ins.results[0]?.id;
  if (!newId) {
    const again = await getPhoto(d.db, photo.id);
    if (again?.item_id) return (await getItem(d.db, again.item_id))!;
    throw new HttpError(409, "conflict", "This scan could not be saved; please try again");
  }
  if (input.deferIndex) d.defer(indexPhotoSoon(d, photo.id, "reindex"));
  else await indexPhotoSoon(d, photo.id);
  return (await getItem(d.db, newId))!;
}

export async function attachScanToItem(
  d: Deps,
  itemId: number,
  scanId: string,
  side: PhotoSide,
  opts: { deferIndex?: boolean } = {},
): Promise<Item> {
  const item = await getItemRow(d.db, itemId);
  if (!item || item.deleted_at) throw notFound("Item not found");
  const photo = await claimableScan(d, scanId);
  if (photo.item_id === itemId) return (await getItem(d.db, itemId))!;
  if (photo.item_id !== null) throw new HttpError(409, "conflict", "That photo already belongs to another item");
  const existing = await photosForItem(d.db, itemId);
  if (existing.length >= MAX_PHOTOS_PER_ITEM) throw badRequest(`An item can have at most ${MAX_PHOTOS_PER_ITEM} photos`);
  const position = existing.reduce((m, p) => Math.max(m, p.position), -1) + 1;
  const r = await d.db
    .prepare("UPDATE photos SET item_id = ?, side = ?, position = ? WHERE id = ? AND item_id IS NULL")
    .bind(itemId, side, position, scanId)
    .run();
  if (!r.meta.changes) throw new HttpError(409, "conflict", "That photo was already used");
  // A real back photo supersedes "back is the same as the front".
  await d.db
    .prepare(`UPDATE items SET updated_at = ?${side === "back" ? ", back_same = 0" : ""} WHERE id = ?`)
    .bind(nowIso(), itemId)
    .run();
  // Bulk review indexes after responding (and from the bulk quota) so tapping through stays fast.
  if (opts.deferIndex) d.defer(indexPhotoSoon(d, scanId, "reindex"));
  else await indexPhotoSoon(d, scanId);
  return (await getItem(d.db, itemId))!;
}

// ----------------------------------------------------------------------------- photo management

export async function updatePhoto(d: Deps, photoId: string, patch: { side?: PhotoSide; primary?: boolean }): Promise<Item> {
  const photo = await getPhoto(d.db, photoId);
  if (!photo || photo.item_id === null) throw notFound("Photo not found");
  const stmts: D1PreparedStatement[] = [];
  if (patch.side) stmts.push(d.db.prepare("UPDATE photos SET side = ? WHERE id = ?").bind(patch.side, photoId));
  if (patch.primary) {
    stmts.push(d.db.prepare("UPDATE photos SET position = position + 1 WHERE item_id = ?").bind(photo.item_id));
    stmts.push(d.db.prepare("UPDATE photos SET position = 0 WHERE id = ?").bind(photoId));
  }
  stmts.push(d.db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").bind(nowIso(), photo.item_id));
  await d.db.batch(stmts);
  return (await getItem(d.db, photo.item_id))!;
}

export async function deletePhoto(d: Deps, photoId: string): Promise<Item> {
  const photo = await getPhoto(d.db, photoId);
  if (!photo || photo.item_id === null) throw notFound("Photo not found");
  const itemId = photo.item_id;
  await d.index.remove([photoId]);
  await d.db.batch([
    d.db.prepare("DELETE FROM photos WHERE id = ?").bind(photoId),
    d.db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").bind(nowIso(), itemId),
  ]);
  await deletePhotoObjects(d.bucket, [photo.full_key, photo.thumb_key]);
  return (await getItem(d.db, itemId))!;
}

// ----------------------------------------------------------------------------- delete / restore

export async function softDeleteItem(d: Deps, itemId: number): Promise<void> {
  const item = await getItemRow(d.db, itemId);
  if (!item || item.deleted_at) throw notFound("Item not found");
  const photos = await photosForItem(d.db, itemId);
  // Mark deleted first: search results are always filtered through D1, so the item disappears
  // from counts and matches immediately even if the vector removal below fails.
  await d.db.batch([
    d.db.prepare("UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), itemId),
    d.db.prepare("UPDATE photos SET indexed = 0 WHERE item_id = ?").bind(itemId),
  ]);
  await d.index.remove(photos.map((p) => p.id));
}

export async function restoreItem(d: Deps, itemId: number): Promise<Item> {
  const item = await getItemRow(d.db, itemId);
  if (!item || !item.deleted_at) throw notFound("Deleted item not found");
  await d.db.prepare("UPDATE items SET deleted_at = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), itemId).run();
  try {
    await indexStoredPhotos(d, await photosForItem(d.db, itemId));
  } catch (e) {
    console.warn("restore: reindex deferred", (e as Error).message);
  }
  return (await getItem(d.db, itemId))!;
}

/** Permanently remove an item that is already in "Recently deleted" (or any demo item). */
export async function purgeItem(d: Deps, itemId: number, opts: { allowLive?: boolean } = {}): Promise<void> {
  const item = await getItemRow(d.db, itemId);
  if (!item) throw notFound("Item not found");
  if (!item.deleted_at && !opts.allowLive) throw badRequest("Move the item to Recently deleted first");
  const photos = await photosForItem(d.db, itemId);
  await d.index.remove(photos.map((p) => p.id));
  await d.db.batch([
    d.db.prepare("DELETE FROM photos WHERE item_id = ?").bind(itemId),
    d.db.prepare("DELETE FROM items WHERE id = ?").bind(itemId),
  ]);
  await deletePhotoObjects(d.bucket, photos.flatMap((p) => [p.full_key, p.thumb_key]));
}

export async function purgeDemo(d: Deps, limit = 25): Promise<{ purged: number; remaining: number }> {
  const { results } = await d.db.prepare("SELECT id FROM items WHERE is_demo = 1 LIMIT ?").bind(limit).all<{ id: number }>();
  for (const r of results) await purgeItem(d, r.id, { allowLive: true });
  const left = await d.db.prepare("SELECT COUNT(*) AS n FROM items WHERE is_demo = 1").first<{ n: number }>();
  return { purged: results.length, remaining: left!.n };
}

/** Remove scans that were never saved (photo rows without an item) after 24h. */
export async function cleanupScans(d: Deps, limit = 25): Promise<number> {
  const cutoff = new Date(Date.now() - SCAN_TTL_MS).toISOString();
  const { results } = await d.db
    // Bulk-uploaded photos wait for review as long as it takes.
    .prepare(
      `SELECT id, full_key, thumb_key FROM photos
       WHERE item_id IS NULL AND created_at < ? AND id NOT IN (SELECT photo_id FROM bulk_photos)
         AND id NOT IN (SELECT back_photo_id FROM bulk_photos WHERE back_photo_id IS NOT NULL) LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<{ id: string; full_key: string; thumb_key: string }>();
  if (!results.length) return 0;
  await deletePhotoObjects(d.bucket, results.flatMap((r) => [r.full_key, r.thumb_key]));
  await d.db
    .prepare(`DELETE FROM photos WHERE item_id IS NULL AND id IN (${results.map(() => "?").join(",")})`)
    .bind(...results.map((r) => r.id))
    .run();
  return results.length;
}

/** Permanently erase koozies that have been in "Recently deleted" longer than TRASH_DAYS. */
export async function emptyTrash(d: Deps, limit = 25): Promise<number> {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { results } = await d.db
    .prepare("SELECT id FROM items WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?")
    .bind(cutoff, limit)
    .all<{ id: number }>();
  for (const r of results) await purgeItem(d, r.id);
  return results.length;
}

/**
 * Daily cron: erase expired trash and abandoned scans, so no photo outlives its record, and retry
 * search indexing that failed in the background (a rate-limited burst of bulk reviews, say). Small
 * batches keep each step inside Workers Free's CPU limit; whatever is left goes tomorrow.
 */
export async function dailyMaintenance(d: Deps): Promise<{ scans: number; purged: number; indexed: number }> {
  let scans = 0;
  let purged = 0;
  for (let i = 0; i < 20; i++) {
    const n = await cleanupScans(d);
    scans += n;
    if (n < 25) break;
  }
  for (let i = 0; i < 4; i++) {
    const n = await emptyTrash(d);
    purged += n;
    if (n < 25) break;
  }
  let indexed = 0;
  for (let i = 0; i < 10; i++) {
    const r = await reindex(d, 10);
    indexed += r.embedded + r.indexed;
    if (!r.remaining || r.stopped_reason || r.embedded + r.indexed === 0) break;
  }
  return { scans, purged, indexed };
}

// ----------------------------------------------------------------------------- reindex

/**
 * Bring the vector index up to date in small, resumable steps (the client loops until
 * `remaining` is 0). Photos that already have an embedding from the current model are
 * re-indexed without calling the embedding API.
 */
export async function reindex(d: Deps, limit: number, reset = false): Promise<ReindexResponse> {
  if (reset) await d.db.prepare("UPDATE photos SET indexed = 0 WHERE item_id IS NOT NULL").run();
  const { results } = await d.db
    .prepare(
      `SELECT p.* FROM photos p JOIN items i ON i.id = p.item_id
       WHERE i.deleted_at IS NULL AND p.indexed = 0
       ORDER BY (p.embed_error IS NOT NULL), p.created_at LIMIT ?`, // previously failed photos go last
    )
    .bind(Math.min(Math.max(limit, 1), 50))
    .all<PhotoRow>();

  let embedded = 0;
  let failed = 0;
  let stopped: string | undefined;
  const ready: PhotoRow[] = [];
  for (const p of results) {
    if (p.embedding && p.embedding_model === d.embedder.modelId) {
      ready.push(p);
      continue;
    }
    if (stopped) continue;
    try {
      await checkQuota(d, "reindex");
      const vec = await embedAndStore(d, p.id, await readFull(d, p));
      ready.push({ ...p, embedding: toBlob(vec), embedding_model: d.embedder.modelId });
      embedded++;
    } catch (e) {
      if (e instanceof AiError && (e.kind === "rate_limited" || e.kind === "quota" || e.kind === "unavailable")) {
        stopped = e.message.slice(0, 200);
      } else {
        failed++;
        if (e instanceof HttpError) {
          await d.db.prepare("UPDATE photos SET embed_error = ? WHERE id = ?").bind(e.message, p.id).run();
        }
      }
    }
  }
  const indexed = await indexStoredPhotos(d, ready);
  const left = await d.db
    .prepare(
      `SELECT COUNT(*) AS n FROM photos p JOIN items i ON i.id = p.item_id
       WHERE i.deleted_at IS NULL AND p.indexed = 0`,
    )
    .first<{ n: number }>();
  // Callers loop while remaining > 0 and the last pass made progress.
  return { embedded, indexed, failed, remaining: left!.n, stopped_reason: stopped };
}

// ----------------------------------------------------------------------------- import

export interface ImportMeta {
  externalRef: string | null;
  /** Catalogue number from the spreadsheet; used when it isn't already taken. */
  number?: number | null;
  fields: ItemFields;
  acquiredOn?: string;
  extraJson: string | null;
  isDemo: boolean;
  sides: PhotoSide[];
}

/**
 * Create one item from an imported row plus 0..n photos. Idempotent on `externalRef`, so an
 * interrupted import can simply be re-run. Embeddings are generated later by `reindex`.
 */
export async function importItem(
  d: Deps,
  meta: ImportMeta,
  photos: { full: unknown; thumb: unknown; name: string | null }[],
): Promise<{ status: "created" | "exists"; id: number; photos: number }> {
  if (meta.externalRef) {
    const existing = await d.db.prepare("SELECT id FROM items WHERE external_ref = ?").bind(meta.externalRef).first<{ id: number }>();
    if (existing) return { status: "exists", id: existing.id, photos: 0 };
  }
  if (photos.length > MAX_PHOTOS_PER_ITEM) throw badRequest(`At most ${MAX_PHOTOS_PER_ITEM} photos per item`);
  // Store photos first (as unclaimed scans) so a failure leaves no half-created item behind.
  const stored: string[] = [];
  for (const p of photos) stored.push((await storePhoto(d, p.full, p.thumb, p.name)).id);

  // Keep the spreadsheet's number when it's free, so K-0042 stays K-0042.
  const taken = meta.number ? await d.db.prepare("SELECT 1 FROM items WHERE id = ?").bind(meta.number).first() : null;
  const insert = insertItemStatement(d.db, {
    id: meta.number && !taken ? meta.number : undefined,
    fields: meta.fields,
    status: "active",
    acquiredOn: meta.acquiredOn,
    origin: "import",
    externalRef: meta.externalRef,
    extraJson: meta.extraJson,
    isDemo: meta.isDemo,
  });
  const claims = stored.map((id, i) =>
    d.db.prepare("UPDATE photos SET item_id = last_insert_rowid(), side = ?, position = ? WHERE id = ?").bind(meta.sides[i] ?? "front", i, id),
  );
  let newId: number | undefined;
  try {
    // last_insert_rowid() is unaffected by UPDATEs, so every claim sees the new item id.
    const [ins] = await d.db.batch<{ id: number }>([insert, ...claims]);
    newId = ins.results[0]?.id;
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE") && meta.externalRef) {
      const existing = await d.db.prepare("SELECT id FROM items WHERE external_ref = ?").bind(meta.externalRef).first<{ id: number }>();
      if (existing) return { status: "exists", id: existing.id, photos: 0 };
    }
    throw e;
  }
  if (!newId) throw new HttpError(500, "import_failed", "Import insert returned no id");
  return { status: "created", id: newId, photos: stored.length };
}

export { photoKeys };
