// How visitors can add to the collection: the collector's wish list and a few featured picks
// (public), plus the mailing address that approved offers are emailed (private). Edited in Tools.

import type { ContributeAdmin, ContributeInfo, WishItem } from "../shared/types";
import { getSetting, nowIso, setSetting } from "./db";
import { badRequest } from "./errors";

const TEXT_MAX = 2000;

/** Links must be plain http(s) (or mailto: where allowed); anything else (javascript:, data:) is refused. */
export function cleanUrl(v: unknown, field: string, allowMailto = false): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw badRequest(`${field} must be a link`);
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw badRequest(`${field} must be a full link starting with https://`);
  }
  const ok = u.protocol === "https:" || u.protocol === "http:" || (allowMailto && u.protocol === "mailto:");
  if (!ok) throw badRequest(`${field} must start with https://${allowMailto ? " or mailto:" : ""}`);
  return u.toString().slice(0, 1000);
}

function cleanText(v: unknown, field: string, max = TEXT_MAX): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw badRequest(`${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return s || null;
}

export async function getContribute(db: D1Database): Promise<ContributeInfo> {
  const [wishlist, items, goal, count] = await Promise.all([
    getSetting(db, "contribute_wishlist_url"),
    db.prepare("SELECT id, title, url, note, image_url FROM wishlist ORDER BY id DESC").all<WishItem>(),
    getSetting(db, "goal"),
    db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND status = 'active' AND is_demo = 0").first<{ n: number }>(),
  ]);
  return { wishlist_url: wishlist, items: items.results, goal: goal ? Number(goal) : null, total: count?.n ?? 0 };
}

/** Never served from /pub: the mailing address only goes out in an approval email. */
export async function getContributeAdmin(db: D1Database, emailEnabled: boolean): Promise<ContributeAdmin> {
  const [info, address] = await Promise.all([getContribute(db), getSetting(db, "mailing_address")]);
  return { ...info, mailing_address: address, email_enabled: emailEnabled };
}

export async function setContribute(db: D1Database, body: Record<string, unknown>) {
  if ("wishlist_url" in body) await setSetting(db, "contribute_wishlist_url", cleanUrl(body.wishlist_url, "Wish list link"));
  if ("mailing_address" in body) await setSetting(db, "mailing_address", cleanText(body.mailing_address, "Mailing address", 500));
}

export async function addWish(db: D1Database, body: Record<string, unknown>): Promise<void> {
  const title = cleanText(body.title, "Title", 200);
  if (!title) throw badRequest("A pick needs a title");
  const url = cleanUrl(body.url, "Link");
  if (!url) throw badRequest("A pick needs a link");
  await db
    .prepare("INSERT INTO wishlist (title, url, note, image_url, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(title, url, cleanText(body.note, "Note", 300), cleanUrl(body.image_url, "Image link"), nowIso())
    .run();
}

export async function deleteWish(db: D1Database, id: number) {
  await db.prepare("DELETE FROM wishlist WHERE id = ?").bind(id).run();
}
