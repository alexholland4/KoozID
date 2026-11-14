import type { MatchBand } from "../../shared/types";
import type { PhotoHit } from "./index";

export interface RankedItem {
  itemId: number;
  score: number;
  photoId: string;
}

/**
 * Collapse photo-level hits to item-level candidates. Each item scores as its best-matching
 * photo, so indexing a koozie's front and back separately lets a back-side scan still find it.
 */
export function rankItems(hits: PhotoHit[], photoToItem: Map<string, number>, limit: number): RankedItem[] {
  const best = new Map<number, RankedItem>();
  for (const h of hits) {
    const itemId = photoToItem.get(h.photoId);
    if (itemId === undefined) continue; // stale vector (deleted photo/item) – ignore
    const cur = best.get(itemId);
    if (!cur || h.score > cur.score) best.set(itemId, { itemId, score: h.score, photoId: h.photoId });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.itemId - b.itemId).slice(0, limit);
}

/**
 * Map a cosine score onto a coarse label. Thresholds are calibrated with `npm run eval` against
 * labelled examples; the UI shows the label, never a fake "percent duplicate".
 */
export function band(score: number, strong: number, possible: number): MatchBand {
  if (score >= strong) return "strong";
  if (score >= possible) return "possible";
  return "weak";
}
