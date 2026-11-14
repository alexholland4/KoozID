// Typed fetch wrapper for the Worker API.

import type {
  ApiErrorBody,
  BulkPhoto,
  BulkQueue,
  DescribeResponse,
  FieldValues,
  Item,
  ItemFields,
  ItemListResponse,
  ItemStatus,
  Me,
  PhotoSide,
  ContributeAdmin,
  ContributeInfo,
  Contribution,
  ContributionKind,
  ContributionResult,
  ContributionStatus,
  Insights,
  SourceRow,
  ItemSummary,
  OnThisDay,
  PublicCheck,
  PublicItem,
  PublicStats,
  ReindexResponse,
  ScanResponse,
  Stats,
} from "../shared/types";
import type { PreparedImage } from "./image";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Cloudflare Access session expired: the API answers with a redirect to the login page. */
export class SessionExpired extends ApiError {
  constructor() {
    super(401, "session_expired", "Your sign-in has expired.");
  }
}

function expired(): SessionExpired {
  window.dispatchEvent(new Event("koozid:session-expired"));
  return new SessionExpired();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (method !== "GET") headers["x-koozid"] = "1";
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, redirect: "manual", credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", navigator.onLine ? "Couldn't reach KoozID. Check your connection and try again." : "You're offline.");
  }
  if (res.type === "opaqueredirect" || res.status === 401) throw expired();
  const isJson = res.headers.get("content-type")?.includes("application/json");
  if (!isJson) {
    if (res.ok) throw expired(); // HTML login page served in place of JSON
    throw new ApiError(res.status, "http", `Request failed (${res.status})`);
  }
  const data = await res.json();
  if (!res.ok) {
    const e = (data as ApiErrorBody).error;
    throw new ApiError(res.status, e?.code ?? "http", e?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

// Guests load photos through the public endpoint, which only serves photos of visible koozies.
let photoBase = "/api/photos";
export const setGuestPhotos = (guest: boolean) => void (photoBase = guest ? "/pub/photos" : "/api/photos");
export const photoUrl = (id: string, variant: "thumb" | "full" = "thumb") => `${photoBase}/${id}/${variant}`;

/** Who is signed in, or null for a guest. Unlike `api.me`, a missing session isn't an error here. */
export async function checkSession(): Promise<Me | null> {
  let res: Response;
  try {
    res = await fetch("/api/me", { redirect: "manual", credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "Couldn't reach KoozID. Check your connection and try again.");
  }
  if (res.ok && res.headers.get("content-type")?.includes("application/json")) return (await res.json()) as Me;
  return null;
}

async function pubGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/pub${path}`);
  } catch {
    throw new ApiError(0, "network", navigator.onLine ? "Couldn't reach KoozID. Check your connection and try again." : "You're offline.");
  }
  const data = (await res.json().catch(() => null)) as Partial<ApiErrorBody> | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "http", data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

/** The guest view's read-only API. */
export const pub = {
  stats: () => pubGet<PublicStats>("/stats"),
  list: (p: { q?: string; source?: string; sort?: string; order?: "asc" | "desc"; offset?: number; limit?: number }) =>
    pubGet<ItemListResponse>(`/items?${qs(p as Record<string, string | number | undefined>)}`),
  item: (id: number) => pubGet<PublicItem>(`/items/${id}`),
  random: () => pubGet<{ id: number }>("/random"),
  contribute: () => pubGet<ContributeInfo>("/contribute"),
  sample: (n = 12) => pubGet<{ items: ItemSummary[] }>(`/sample?n=${n}`),
  onThisDay: (date: string) => pubGet<OnThisDay>(`/on-this-day?date=${date}`),
  async check(photo: Blob): Promise<PublicCheck> {
    const fd = new FormData();
    fd.set("photo", photo, "photo.jpg");
    let res: Response;
    try {
      res = await fetch("/pub/check", { method: "POST", body: fd, headers: { "x-koozid": "1" } });
    } catch {
      throw new ApiError(0, "network", "Couldn't reach KoozID. Check your connection and try again.");
    }
    const data = (await res.json().catch(() => null)) as (PublicCheck & Partial<ApiErrorBody>) | null;
    if (!res.ok || !data) throw new ApiError(res.status, data?.error?.code ?? "http", data?.error?.message ?? `Request failed (${res.status})`);
    return data;
  },
  insights: () => pubGet<Insights>("/insights"),
  async offer(body: { kind: ContributionKind; name: string; email: string; quantity?: string | null; checked?: string | null; website?: string }) {
    let res: Response;
    try {
      res = await fetch("/pub/offers", { method: "POST", body: JSON.stringify(body), headers: { "x-koozid": "1", "content-type": "application/json" } });
    } catch {
      throw new ApiError(0, "network", "Couldn't reach KoozID. Check your connection and try again.");
    }
    const data = (await res.json().catch(() => null)) as ({ kind: ContributionKind; status: ContributionStatus } & Partial<ApiErrorBody>) | null;
    if (!res.ok || !data) throw new ApiError(res.status, data?.error?.code ?? "http", data?.error?.message ?? `Request failed (${res.status})`);
    return data;
  },
};

export type OfferTab = "new" | "approved" | "done";

export interface ListParams {
  q?: string;
  source?: string;
  status?: ItemStatus | "all";
  photo?: "none";
  sort?: string;
  order?: "asc" | "desc";
  offset?: number;
  limit?: number;
  deleted?: boolean;
}

export const api = {
  me: () => request<Me>("GET", "/me"),
  stats: () => request<Stats>("GET", "/stats"),
  values: () => request<FieldValues>("GET", "/values"),

  scan(img: PreparedImage, search = true) {
    const fd = new FormData();
    fd.set("full", img.full, "photo.jpg");
    fd.set("thumb", img.thumb, "thumb.jpg");
    if (img.name) fd.set("name", img.name);
    if (!search) fd.set("search", "0");
    return request<ScanResponse>("POST", "/scans", fd);
  },
  describe: (scanId: string, backScanId?: string | null) =>
    request<DescribeResponse>("POST", `/scans/${scanId}/describe${backScanId ? `?back=${backScanId}` : ""}`),

  createItem: (
    body: ItemFields & {
      scan_id: string;
      status: ItemStatus;
      review_note?: string | null;
      side: PhotoSide;
      acquired_on?: string;
      back_scan_id?: string | null;
      back_same?: boolean;
    },
  ) =>
    request<Item>("POST", "/items", body),
  list: (p: ListParams) =>
    request<ItemListResponse>("GET", `/items?${qs({ ...p, deleted: p.deleted ? 1 : undefined } as Record<string, string | number | undefined>)}`),
  item: (id: number) => request<Item>("GET", `/items/${id}`),
  updateItem: (id: number, patch: Partial<ItemFields> & { status?: ItemStatus; review_note?: string | null; acquired_on?: string; back_same?: boolean }) =>
    request<Item>("PATCH", `/items/${id}`, patch),
  deleteItem: (id: number) => request<{ ok: true }>("DELETE", `/items/${id}`),
  restoreItem: (id: number) => request<Item>("POST", `/items/${id}/restore`),
  purgeItem: (id: number) => request<{ ok: true }>("DELETE", `/items/${id}/purge`),
  attachPhoto: (id: number, scanId: string, side: PhotoSide, background = false) =>
    request<Item>("POST", `/items/${id}/photos`, { scan_id: scanId, side, background }),
  updatePhoto: (photoId: string, patch: { side?: PhotoSide; primary?: boolean }) => request<Item>("PATCH", `/photos/${photoId}`, patch),
  deletePhoto: (photoId: string) => request<Item>("DELETE", `/photos/${photoId}`),

  exportPage: (offset: number, limit = 200) =>
    request<{ items: Item[]; next_offset: number | null; exported_at: string }>("GET", `/export/items?offset=${offset}&limit=${limit}`),
  importItem: (fd: FormData) => request<{ status: "created" | "exists"; id: number; photos: number }>("POST", "/admin/import", fd),
  reindex: (limit = 10, reset = false) => request<ReindexResponse>("POST", "/admin/reindex", { limit, reset }),
  bulkUpload(img: PreparedImage) {
    const fd = new FormData();
    fd.set("full", img.full, "photo.jpg");
    fd.set("thumb", img.thumb, "thumb.jpg");
    if (img.name) fd.set("name", img.name);
    return request<{ photo_id: string; status: "queued" | "duplicate" }>("POST", "/admin/bulk/photos", fd);
  },
  bulkMatch: (photoId: string) => request<BulkPhoto>("POST", `/admin/bulk/photos/${photoId}/match`),
  bulkQueue: (opts: { pending?: boolean; limit?: number } = {}) =>
    request<BulkQueue>("GET", `/bulk?${qs({ status: opts.pending ? "pending" : undefined, limit: opts.limit })}`),
  bulkAccept: (photoId: string, itemId: number) => request<Item>("POST", `/bulk/${photoId}/accept`, { item_id: itemId }),
  bulkNew: (photoId: string, body: ItemFields & { acquired_on?: string }) => request<Item>("POST", `/bulk/${photoId}/new`, body),
  bulkSkip: (photoId: string) => request<{ ok: true }>("POST", `/bulk/${photoId}/skip`),
  bulkDiscard: (photoId: string) => request<{ ok: true }>("DELETE", `/bulk/${photoId}`),

  setGoal: (goal: number | null) => request<{ goal: number | null }>("PUT", "/admin/settings", { goal }),
  contributeAdmin: () => request<ContributeAdmin>("GET", "/admin/contribute"),
  emailTest: () => request<{ sent: boolean; to?: string; error?: string }>("POST", "/admin/email-test"),
  setContribute: (body: Partial<Pick<ContributeAdmin, "wishlist_url" | "mailing_address">>) => request<ContributeAdmin>("PUT", "/admin/contribute", body),
  addWish: (body: { title: string; url: string; note?: string | null; image_url?: string | null }) => request<ContributeAdmin>("POST", "/admin/wishlist", body),
  deleteWish: (id: number) => request<ContributeAdmin>("DELETE", `/admin/wishlist/${id}`),
  offers: (tab: OfferTab) =>
    request<{ offers: Contribution[]; counts: Record<OfferTab, number>; email_enabled: boolean }>("GET", `/admin/offers?status=${tab}`),
  offerAction: (id: number, action: "approve" | "decline" | "reopen" | "resend") => request<ContributionResult>("POST", `/admin/offers/${id}/${action}`),
  thankOffer: (id: number, itemIds: number[]) => request<ContributionResult>("POST", `/admin/offers/${id}/thank`, { item_ids: itemIds }),
  sources: () => request<{ sources: SourceRow[] }>("GET", "/admin/sources"),
  groupSources: (contributor: string, sources: string[], previous?: string) =>
    request<{ sources: SourceRow[] }>("PUT", "/admin/source-groups", { contributor, sources, previous }),
  ungroupSources: (sources: string[]) => request<{ sources: SourceRow[] }>("DELETE", "/admin/source-groups", { sources }),
  purgeDemo: () => request<{ purged: number; remaining: number }>("POST", "/admin/demo/purge"),
  usage: () => request<{ usage: { day: string; kind: string; count: number }[] }>("GET", "/admin/usage"),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
