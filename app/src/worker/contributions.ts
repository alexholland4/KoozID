// Koozie offers from visitors and leaderboard groups.
//
// Send flow: a visitor offers a koozie (name, email, how many) -> the collector is notified ->
// he approves -> the visitor is emailed his mailing address, which is never public -> the koozie
// arrives and is catalogued -> he picks the catalogue number(s) and the visitor gets a thank-you
// linking to them. Gifts from the wish list skip approval (Amazon ships without the address).

import type { Contribution, ContributionKind, ContributionResult, ContributionStatus, SourceRow } from "../shared/types";
import { QUANTITIES, itemCode } from "../shared/types";
import { EMAIL_RE } from "../shared/contribute";
import { bumpUsage, getSetting, nowIso, summariesByIds } from "./db";
import { approvalEmail, offerNotice, thanksEmail } from "./emails";
import type { Config } from "./env";
import { badRequest, HttpError, notFound } from "./errors";
import { deliver, type Mailer } from "./mail";

interface Row {
  id: number;
  kind: ContributionKind;
  name: string;
  email: string;
  quantity: string | null;
  checked: "new" | "maybe" | null;
  status: ContributionStatus;
  item_ids: string | null;
  created_at: string;
  decided_at: string | null;
  thanked_at: string | null;
}

const toContribution = (r: Row): Contribution => ({ ...r, item_ids: r.item_ids ? (JSON.parse(r.item_ids) as number[]) : [] });

async function getRow(db: D1Database, id: number): Promise<Contribution> {
  const r = await db.prepare("SELECT * FROM contributions WHERE id = ?").bind(id).first<Row>();
  if (!r) throw notFound("Request not found");
  return toContribution(r);
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The public form. Returns what the visitor sees next; never reveals the mailing address. */
export async function submitOffer(
  db: D1Database,
  cfg: Config,
  mailer: Mailer,
  body: Record<string, unknown>,
  base: string,
  defer: (p: Promise<unknown>) => void,
): Promise<{ kind: ContributionKind; status: ContributionStatus }> {
  const kind: ContributionKind = body.kind === "gift" ? "gift" : "send";
  // A hidden field people never see; bots fill it in. Pretend it worked.
  if (str(body.website)) return { kind, status: kind === "gift" ? "approved" : "new" };

  const name = str(body.name).replace(/\s+/g, " ");
  const email = str(body.email).toLowerCase();
  if (!name) throw badRequest("Please add your name");
  if (name.length > 100) throw badRequest("That name is too long");
  if (!EMAIL_RE.test(email) || email.length > 254) throw badRequest("That email address doesn't look right");
  const quantity = body.quantity === undefined || body.quantity === null || body.quantity === "" ? null : String(body.quantity);
  if (quantity !== null && !(QUANTITIES as readonly string[]).includes(quantity)) throw badRequest("Pick how many from the list");
  const checked = body.checked === "new" || body.checked === "maybe" ? body.checked : null;

  // The same person tapping twice (or coming back later) updates their open request instead of
  // stacking duplicates, and doesn't notify the collector again.
  const open = await db
    .prepare("SELECT * FROM contributions WHERE email = ? AND kind = ? AND status = ? ORDER BY id DESC LIMIT 1")
    .bind(email, kind, kind === "gift" ? "approved" : "new")
    .first<Row>();
  if (open) {
    await db
      .prepare("UPDATE contributions SET name = ?, quantity = COALESCE(?, quantity), checked = COALESCE(?, checked) WHERE id = ?")
      .bind(name, quantity, checked, open.id)
      .run();
    return { kind, status: open.status };
  }

  if ((await bumpUsage(db, "offer")) > cfg.publicOfferDailyLimit) {
    throw new HttpError(429, "quota", "We've had a lot of offers today. Please try again tomorrow!");
  }
  const status: ContributionStatus = kind === "gift" ? "approved" : "new";
  const now = nowIso();
  const row = await db
    .prepare(
      `INSERT INTO contributions (kind, name, email, quantity, checked, status, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(kind, name, email, quantity, checked, status, now, kind === "gift" ? now : null)
    .first<Row>();

  if (mailer.enabled && cfg.notifyEmails.length) {
    const notice = offerNotice(toContribution(row!), base);
    defer(Promise.all(cfg.notifyEmails.map((to) => deliver(mailer, { ...notice, to }))));
  }
  return { kind, status };
}

export async function listOffers(db: D1Database, which: "new" | "approved" | "done"): Promise<Contribution[]> {
  const where = which === "done" ? "status IN ('thanked', 'declined')" : "status = ?";
  const order = which === "done" ? "COALESCE(thanked_at, decided_at) DESC" : which === "approved" ? "decided_at ASC" : "id ASC";
  const stmt = db.prepare(`SELECT * FROM contributions WHERE ${where} ORDER BY ${order}, id DESC LIMIT 200`);
  const { results } = await (which === "done" ? stmt : stmt.bind(which)).all<Row>();
  return results.map(toContribution);
}

export async function offerCounts(db: D1Database) {
  const { results } = await db.prepare("SELECT status, COUNT(*) AS n FROM contributions GROUP BY status").all<{ status: ContributionStatus; n: number }>();
  const n = (s: ContributionStatus) => results.find((r) => r.status === s)?.n ?? 0;
  return { new: n("new"), approved: n("approved"), done: n("thanked") + n("declined") };
}

async function mailingAddress(db: D1Database): Promise<string> {
  const address = await getSetting(db, "mailing_address");
  if (!address) throw badRequest("Add your mailing address in Tools first, so there's something to send");
  return address;
}

/** Approve a "send" offer and email the mailing address (or hand back the draft). */
export async function approveOffer(db: D1Database, mailer: Mailer, id: number, base: string): Promise<ContributionResult> {
  const c = await getRow(db, id);
  if (c.kind !== "send") throw badRequest("Gifts don't need approving");
  const address = await mailingAddress(db);
  if (c.status === "new") {
    await db.prepare("UPDATE contributions SET status = 'approved', decided_at = ? WHERE id = ?").bind(nowIso(), id).run();
  }
  const email = await deliver(mailer, approvalEmail(c, address, base));
  return { contribution: await getRow(db, id), email };
}

export async function declineOffer(db: D1Database, id: number): Promise<ContributionResult> {
  await getRow(db, id);
  await db.prepare("UPDATE contributions SET status = 'declined', decided_at = ? WHERE id = ?").bind(nowIso(), id).run();
  return { contribution: await getRow(db, id), email: null };
}

/** Put a declined or thanked request back in the queue it came from (mistaps happen). */
export async function reopenOffer(db: D1Database, id: number): Promise<ContributionResult> {
  const c = await getRow(db, id);
  const status: ContributionStatus = c.kind === "gift" || c.thanked_at ? "approved" : "new";
  await db.prepare("UPDATE contributions SET status = ?, thanked_at = NULL WHERE id = ?").bind(status, id).run();
  return { contribution: await getRow(db, id), email: null };
}

/** The koozie(s) arrived and are catalogued: thank the visitor with links to them. */
export async function thankOffer(db: D1Database, mailer: Mailer, id: number, rawIds: unknown, base: string): Promise<ContributionResult> {
  const c = await getRow(db, id);
  if (c.status === "new" || c.status === "declined") throw badRequest("Approve the request first");
  const ids = Array.isArray(rawIds) ? [...new Set(rawIds.map(Number))] : [];
  if (!ids.length || ids.length > 50 || !ids.every((n) => Number.isSafeInteger(n) && n > 0)) throw badRequest("Pick the koozie(s) they sent");
  // Only koozies guests can see: the email links to their public pages.
  const { results } = await db
    .prepare(`SELECT id FROM items WHERE id IN (${ids.map(() => "?").join(",")}) AND deleted_at IS NULL AND status = 'active' AND is_demo = 0`)
    .bind(...ids)
    .all<{ id: number }>();
  const found = new Set(results.map((r) => r.id));
  const missing = ids.filter((n) => !found.has(n));
  if (missing.length) throw badRequest(`${missing.map(itemCode).join(", ")} isn't in the counted collection yet`);

  const sums = await summariesByIds(db, ids);
  const items = ids.map((n) => {
    const s = sums.get(n)!;
    return { id: n, code: s.code, description: s.description, thumb_photo_id: s.thumb_photo_id };
  });
  const [counts, goal] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total FROM items WHERE deleted_at IS NULL AND status = 'active' AND is_demo = 0").first<{ total: number }>(),
    getSetting(db, "goal"),
  ]);
  const email = await deliver(mailer, thanksEmail(c, items, { total: counts?.total ?? 0, goal: goal ? Number(goal) : null }, base));
  await db
    .prepare("UPDATE contributions SET status = 'thanked', item_ids = ?, thanked_at = ? WHERE id = ?")
    .bind(JSON.stringify(ids), nowIso(), id)
    .run();
  return { contribution: await getRow(db, id), email };
}

/** Send an earlier email again: the address after approval, or the thank-you. */
export async function resendOffer(db: D1Database, mailer: Mailer, id: number, base: string): Promise<ContributionResult> {
  const c = await getRow(db, id);
  if (c.status === "thanked") return thankOffer(db, mailer, id, c.item_ids, base);
  if (c.status === "approved" && c.kind === "send") return approveOffer(db, mailer, id, base);
  throw badRequest("Nothing to send for this request yet");
}

// ------------------------------------------------------------------ leaderboard groups

/** Every exact source in use, with its group, most koozies first. */
export async function listSources(db: D1Database): Promise<SourceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT i.acquired_from AS name, COUNT(*) AS count, MAX(g.contributor) AS contributor
       FROM items i LEFT JOIN source_groups g ON g.source = i.acquired_from
       WHERE i.deleted_at IS NULL AND i.acquired_from IS NOT NULL AND i.acquired_from != ''
       GROUP BY i.acquired_from ORDER BY count DESC, name`,
    )
    .all<SourceRow>();
  return results;
}

/** Count these sources as one contributor (also renames a group: pass all its sources). */
export async function groupSources(db: D1Database, body: Record<string, unknown>) {
  const contributor = str(body.contributor).replace(/\s+/g, " ");
  if (!contributor) throw badRequest("Give the group a name");
  if (contributor.length > 200) throw badRequest("That name is too long");
  const sources = Array.isArray(body.sources) ? [...new Set(body.sources.map(str).filter(Boolean))] : [];
  if (!sources.length || sources.length > 200) throw badRequest("Pick the sources to combine");
  // A group's own name is fine as a member too ("Mom" covering "Mom" and "Gift from mom").
  await db.batch(
    sources.map((s) =>
      db.prepare("INSERT INTO source_groups (source, contributor) VALUES (?, ?) ON CONFLICT (source) DO UPDATE SET contributor = excluded.contributor").bind(s, contributor),
    ),
  );
  // Renaming every member leaves no stragglers under the old name.
  if (typeof body.previous === "string" && body.previous.trim() && body.previous.trim() !== contributor) {
    await db.prepare("UPDATE source_groups SET contributor = ? WHERE contributor = ?").bind(contributor, body.previous.trim()).run();
  }
}

export async function ungroupSources(db: D1Database, body: Record<string, unknown>) {
  const sources = Array.isArray(body.sources) ? body.sources.map(str).filter(Boolean) : [];
  if (!sources.length) throw badRequest("Pick the sources to separate");
  await db.batch(sources.map((s) => db.prepare("DELETE FROM source_groups WHERE source = ?").bind(s)));
}
