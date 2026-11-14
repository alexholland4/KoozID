// Types shared by the Worker API and the React client.

export type ItemStatus = "active" | "needs_review";
export type PhotoSide = "front" | "back" | "other";
export type MatchBand = "strong" | "possible" | "weak";

/** Editable fields of an item. They mirror the collector's spreadsheet columns. */
export interface ItemFields {
  description: string;
  /** Body colour(s), e.g. "navy blue" or "white/gold". */
  color: string | null;
  size: string | null;
  base: string | null;
  /** The spreadsheet's "Source": who gave it or where it was bought. */
  acquired_from: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  visible_text: string | null;
  notes: string | null;
}

/** The text fields, in form order. `acquired_on` is a separate, required date. */
export const FIELD_KEYS = ["description", "color", "size", "base", "acquired_from", "city", "state", "country", "visible_text", "notes"] as const;

/** Values from the collector's spreadsheet, offered as choices (free text is still allowed). */
export const SIZES = ["Standard Can", "Tall Can", "Large Can", "Standard Bottle"] as const;
export const BASES = ["Collapsible", "Structured", "Slap", "Metal"] as const;

export interface PhotoInfo {
  id: string;
  side: PhotoSide;
  position: number;
  width: number;
  height: number;
  indexed: boolean;
  embed_error: string | null;
}

export interface ItemSummary {
  id: number;
  code: string; // K-0001
  status: ItemStatus;
  description: string;
  color: string | null;
  size: string | null;
  base: string | null;
  acquired_from: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  acquired_on: string;
  thumb_photo_id: string | null;
  photo_count: number;
}

export interface Item extends ItemFields {
  id: number;
  code: string;
  status: ItemStatus;
  review_note: string | null;
  acquired_on: string;
  origin: "scan" | "import" | "manual";
  external_ref: string | null;
  extra: Record<string, string> | null;
  is_demo: boolean;
  /** The back shows the same design as the front, so there's no separate back photo. */
  back_same: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  photos: PhotoInfo[];
}

/** What guests see of a koozie: no notes or review state. */
export interface PublicItem {
  id: number;
  code: string;
  description: string;
  color: string | null;
  size: string | null;
  base: string | null;
  acquired_from: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  visible_text: string | null;
  acquired_on: string;
  back_same: boolean;
  photos: { id: string; side: PhotoSide }[];
}

export interface PublicStats {
  total: number;
  goal: number | null;
  /** Koozies acquired in the last 90 days, for "at this pace…". */
  last_90_days: number;
}

/** Koozies acquired on this date in the past: today, a month ago, a year ago… */
export interface OnThisDay {
  groups: { label: string; date: string; count: number; items: ItemSummary[] }[];
}

/** A guest's "Do we have this one?" photo check. The photo isn't stored. */
export interface PublicCheck {
  verdict: "have" | "maybe" | "new";
  matches: { item: ItemSummary; band: MatchBand }[];
  /** Counted koozies with no photo yet, which a photo check can't see. */
  unphotographed: number;
}

export interface NameCount {
  name: string;
  count: number;
}

/** Collection statistics for the stats page. Counts cover counted (active) koozies only. */
export interface Insights {
  total: number;
  goal: number | null;
  /** Koozies acquired per day, oldest first (days with none are omitted). */
  days: { day: string; count: number }[];
  /** Most first, all of them. */
  states: NameCount[];
  /** Who gave them / where they came from, with leaderboard groups combined. */
  sources: NameCount[];
  /** Exact sources that are counted under a group name on the leaderboard. */
  groups: SourceAlias[];
  unique_states: number;
  unique_cities: number;
  unique_countries: number;
}

/** A featured pick on the Contribute page, linking out to a store. */
export interface WishItem {
  id: number;
  title: string;
  url: string;
  note: string | null;
  image_url: string | null;
}

/** How visitors can add to the collection. Unset fields show as "coming soon". */
export interface ContributeInfo {
  wishlist_url: string | null;
  items: WishItem[];
  total: number;
  goal: number | null;
}

/** The admin view of the Contribute settings: adds what visitors never see. */
export interface ContributeAdmin extends ContributeInfo {
  /** Emailed to a visitor only after their offer is approved. */
  mailing_address: string | null;
  /** False until an email provider is connected; emails are then drafted for the collector to send. */
  email_enabled: boolean;
}

export interface SourceAlias {
  source: string;
  contributor: string;
}

/** An exact source value, how many koozies carry it, and its leaderboard group if any. */
export interface SourceRow {
  name: string;
  count: number;
  contributor: string | null;
}

export type ContributionKind = "send" | "gift";
export type ContributionStatus = "new" | "approved" | "declined" | "thanked";
export const QUANTITIES = ["1", "2-5", "6-10", "10+"] as const;

/** A visitor's offer of a koozie (mailed in) or a gift (bought from the wish list). */
export interface Contribution {
  id: number;
  kind: ContributionKind;
  name: string;
  email: string;
  quantity: string | null;
  checked: "new" | "maybe" | null;
  status: ContributionStatus;
  item_ids: number[];
  created_at: string;
  decided_at: string | null;
  thanked_at: string | null;
}

export interface EmailDraft {
  to: string;
  subject: string;
  text: string;
}

/** What happened to an email: sent, or handed back as a draft (not connected, or the send failed). */
export interface EmailOutcome {
  sent: boolean;
  error?: string;
  draft: EmailDraft;
}

export interface ContributionResult {
  contribution: Contribution;
  email: EmailOutcome | null;
}

export interface Candidate {
  item: ItemSummary;
  /** Cosine similarity of the best-matching photo. Exposed for diagnostics; the UI shows `band`. */
  score: number;
  band: MatchBand;
  matched_photo_id: string;
  matched_side: PhotoSide;
}

export type SearchStatus = "ok" | "empty" | "unavailable" | "failed" | "skipped";

export interface ScanResponse {
  scan_id: string;
  search_status: SearchStatus;
  search_error?: string;
  candidates: Candidate[];
  /** Item that already holds a byte-identical photo, if any. */
  exact_photo_item: ItemSummary | null;
  /** Live items with no photo. Image search can't see them, so text matches matter more. */
  unphotographed: number;
}

/** What the AI can tell from a photo. Where and when it was acquired is up to the user. */
export interface Suggestion {
  description: string;
  color: string | null;
  size: string | null;
  base: string | null;
  visible_text: string | null;
  model: string;
}

export interface DescribeResponse {
  suggestion: Suggestion | null;
  error?: string;
  /** Items whose stored text overlaps the text the model read on the koozie. */
  text_matches: ItemSummary[];
}

export type MatchConfidence = "high" | "medium" | "low";

/** A bulk-uploaded photo waiting for someone to confirm which record it belongs to. */
export interface BulkPhoto {
  photo_id: string;
  /** The same koozie's back, when it was uploaded as a front/back pair. */
  back_photo_id: string | null;
  status: "pending" | "suggested" | "failed";
  original_name: string | null;
  /** The AI's pick, or null when it found no matching record. */
  item: ItemSummary | null;
  confidence: MatchConfidence | null;
  alternatives: ItemSummary[];
  reason: string | null;
  /** What the AI would write for a new record, if it turns out not to be in the list. */
  suggestion: Suggestion | null;
  error: string | null;
  skipped: boolean;
}

export interface BulkQueue {
  items: BulkPhoto[];
  counts: { pending: number; suggested: number; failed: number };
}

export interface Stats {
  total: number; // active (counted) items
  needs_review: number;
  photos: number;
  pending_index: number;
  deleted: number;
  no_photo: number;
  /** Bulk-uploaded photos waiting for review. */
  bulk_review: number;
  /** Koozie offers from visitors waiting for approval. */
  offers: number;
  /** Target collection size set in Tools, or null. */
  goal: number | null;
  recent: ItemSummary[];
}

/** Previously used values, most frequent first, for autocomplete. */
export interface FieldValues {
  color: string[];
  acquired_from: string[];
  city: string[];
  state: string[];
  country: string[];
}

export interface Me {
  email: string;
  is_admin: boolean;
  auth_mode: "access" | "dev";
  ai_provider: string;
  vector_backend: string;
}

export interface ItemListResponse {
  items: ItemSummary[];
  total: number;
  next_offset: number | null;
}

export interface ReindexResponse {
  embedded: number;
  indexed: number;
  failed: number;
  remaining: number;
  stopped_reason?: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Catalogue number in the collector's format: K-0001 (more digits once past 9999). */
export function itemCode(id: number): string {
  return `K-${String(id).padStart(4, "0")}`;
}

/** Parse "K-0042", "k42", "#42" or "42" back to 42. */
export function parseItemCode(s: string): number | null {
  const m = s.trim().match(/^(?:[a-z]{1,3}[-\s]?|#)?0*(\d{1,9})$/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
