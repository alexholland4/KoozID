// Guest view: a read-only window on the collection that needs no sign-in. Only counted, non-demo
// koozies, and only fields that are fine for strangers to see. Sources are public (people like to
// see what they've contributed); notes and the review queue stay behind sign-in. No AI calls here.

import { Hono } from "hono";
import type { Insights, ItemSummary, NameCount, OnThisDay, PublicCheck, PublicItem, PublicStats, SourceAlias } from "../shared/types";
import { itemCode } from "../shared/types";
import { createDeps } from "./app";
import { getContribute } from "./contribute";
import { submitOffer } from "./contributions";
import { createMailer, type Mailer } from "./mail";
import { searchByVector } from "./catalog";
import { bumpUsage, getSetting, listItems, photosForItem, SORT_KEYS, summariesByIds, type ItemRow, type SortKey } from "./db";
import { getConfig, type Env } from "./env";
import { AiError, badRequest, errorBody, forbidden, HttpError, notFound } from "./errors";
import { validateJpeg } from "./images";
import { parseItemId, parsePhotoId } from "./validation";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const VISIBLE = "deleted_at IS NULL AND status = 'active' AND is_demo = 0";

export function createPublicApp(opts: { mailer?: (cfg: ReturnType<typeof getConfig>) => Mailer } = {}) {
  const app = new Hono<{ Bindings: Env }>().basePath("/pub");

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.message), err.status as 400);
    console.error("unhandled (public)", err);
    return c.json(errorBody("internal", "Something went wrong. Please try again."), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", "Unknown endpoint"), 404));

  // Read-only apart from the photo check (stores nothing) and koozie offers, and briefly cached at
  // the edge so a burst of visitors doesn't multiply D1 reads.
  const WRITES = new Set(["/pub/check", "/pub/offers"]);
  app.use("*", async (c, next) => {
    if (c.req.method === "POST" && WRITES.has(new URL(c.req.url).pathname)) return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Read only");
    const cache = LOCAL_HOSTS.has(new URL(c.req.url).hostname) ? null : (caches as unknown as { default: Cache }).default;
    const key = new Request(c.req.url);
    const hit = await cache?.match(key);
    if (hit) return hit;
    await next();
    if (cache && c.res.ok && c.res.headers.get("cache-control")?.startsWith("public")) {
      const put = cache.put(key, c.res.clone());
      try {
        c.executionCtx.waitUntil(put);
      } catch {
        await put;
      }
    }
  });

  app.get("/stats", async (c) => {
    const db = c.env.DB;
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const [s, goal] = await Promise.all([
      db
        .prepare(`SELECT COUNT(*) AS total, SUM(acquired_on >= ?) AS recent FROM items WHERE ${VISIBLE}`)
        .bind(since)
        .first<{ total: number; recent: number | null }>()
        .then((r) => r!),
      getSetting(db, "goal"),
    ]);
    const body: PublicStats = { total: s.total, goal: goal ? Number(goal) : null, last_90_days: s.recent ?? 0 };
    c.header("cache-control", "public, max-age=60");
    return c.json(body);
  });

  app.get("/items", async (c) => {
    const q = c.req.query();
    // Every column guests can see; "updated" is private bookkeeping.
    const sort = (SORT_KEYS.filter((k) => k !== "updated") as string[]).includes(q.sort) ? (q.sort as SortKey) : "id";
    const offset = Math.max(Number(q.offset) || 0, 0);
    const res = await listItems(c.env.DB, {
      q: q.q?.slice(0, 200),
      sort,
      order: q.order === "asc" ? "asc" : "desc",
      offset,
      limit: Math.min(Number(q.limit) || 48, 96),
      publicOnly: true,
      source: q.source?.slice(0, 200) || undefined,
    });
    const next = offset + res.items.length;
    c.header("cache-control", "public, max-age=60");
    return c.json({ items: res.items, total: res.total, next_offset: next < res.total ? next : null });
  });

  /** A different random handful each visit, photographed koozies first (they make a better carousel). */
  app.get("/sample", async (c) => {
    const n = Math.min(Math.max(Number(c.req.query("n")) || 12, 1), 24);
    const { results } = await c.env.DB.prepare(
      `SELECT id FROM items i WHERE ${VISIBLE}
       ORDER BY EXISTS (SELECT 1 FROM photos p WHERE p.item_id = i.id) DESC, RANDOM() LIMIT ?`,
    )
      .bind(n)
      .all<{ id: number }>();
    const sums = await summariesByIds(c.env.DB, results.map((r) => r.id));
    c.header("cache-control", "no-store");
    return c.json({ items: results.map((r) => sums.get(r.id)).filter(Boolean) });
  });

  /** ?date=YYYY-MM-DD (the visitor's today): what was added on this day a month, a year… ago. */
  app.get("/on-this-day", async (c) => {
    const date = c.req.query("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("date must be YYYY-MM-DD");
    const [y, m, d] = date.split("-").map(Number);
    const iso = (yy: number, mm: number) => {
      // Clamp to the month's length: a month before March 31 is the end of February.
      const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      const t = new Date(Date.UTC(yy, mm - 1, Math.min(d, last)));
      return t.toISOString().slice(0, 10);
    };
    const wanted: [string, string][] = [["Today", date], ["A month ago today", iso(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1)]];
    for (let k = 1; k <= 10; k++) wanted.push([k === 1 ? "A year ago today" : `${k} years ago today`, iso(y - k, m)]);
    const groups: OnThisDay["groups"] = [];
    for (const [label, day] of wanted) {
      const res = await listItems(c.env.DB, { publicOnly: true, sort: "id", order: "asc", limit: 8, on: day });
      if (res.total) groups.push({ label, date: day, count: res.total, items: res.items });
    }
    c.header("cache-control", "public, max-age=300");
    return c.json({ groups } satisfies OnThisDay);
  });

  /**
   * "Do we have this one?": one embedding call, compared against every photographed koozie. The
   * photo is never stored. Capped per day across all visitors so a public endpoint can't run up
   * the AI usage.
   */
  app.post("/check", async (c) => {
    if (c.req.header("x-koozid") !== "1") throw forbidden("Missing request header");
    const cfg = getConfig(c.env);
    const form = await c.req.formData().catch(() => {
      throw badRequest("Expected multipart form data");
    });
    const { bytes } = await validateJpeg(form.get("photo"), "full");
    if ((await bumpUsage(c.env.DB, "public")) > cfg.publicCheckDailyLimit) {
      throw new HttpError(429, "quota", "The koozie checker is taking a break for today. Try again tomorrow!");
    }
    const d = createDeps(c.env, cfg, {}, (p) => {
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        p.catch(() => {});
      }
    });
    let vec: Float32Array;
    try {
      vec = await d.embedder.embedImage(bytes);
    } catch (e) {
      console.error("public check failed", (e as Error).message);
      throw new HttpError(503, "busy", e instanceof AiError && e.kind === "rate_limited" ? "The checker is busy. Try again in a minute." : "Couldn't check that photo. Try again.");
    }
    // Only koozies guests can see count as matches.
    const matches = (await searchByVector(d, vec))
      .filter((m) => m.item.status === "active" && m.band !== "weak")
      .slice(0, 3)
      .map((m) => ({ item: m.item, band: m.band }));
    const bare = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items i WHERE i.deleted_at IS NULL AND i.status = 'active' AND i.is_demo = 0
       AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.item_id = i.id)`,
    ).first<{ n: number }>();
    const body: PublicCheck = {
      verdict: matches[0]?.band === "strong" ? "have" : matches.length ? "maybe" : "new",
      matches,
      unphotographed: bare?.n ?? 0,
    };
    c.header("cache-control", "no-store");
    return c.json(body);
  });

  /** "Send a koozie" / "Gift a koozie": the visitor's name and email, for approval and a thank-you. */
  app.post("/offers", async (c) => {
    if (c.req.header("x-koozid") !== "1") throw forbidden("Missing request header");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Expected a JSON object");
    const cfg = getConfig(c.env);
    const res = await submitOffer(c.env.DB, cfg, (opts.mailer ?? createMailer)(cfg), body, new URL(c.req.url).origin, (p) => {
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        p.catch(() => {});
      }
    });
    c.header("cache-control", "no-store");
    return c.json(res, 201);
  });

  app.get("/contribute", async (c) => {
    // Browsers always re-check, so an edit in Tools shows up right away; the edge copy is cleared on save.
    c.header("cache-control", "public, max-age=0, s-maxage=60");
    return c.json(await getContribute(c.env.DB));
  });

  app.get("/random", async (c) => {
    const r = await c.env.DB.prepare(`SELECT id FROM items WHERE ${VISIBLE} ORDER BY RANDOM() LIMIT 1`).first<{ id: number }>();
    if (!r) throw notFound("No koozies yet");
    c.header("cache-control", "no-store");
    return c.json({ id: r.id });
  });

  app.get("/insights", async (c) => {
    const db = c.env.DB;
    const nonEmpty = (col: string) => `${col} IS NOT NULL AND ${col} != ''`;
    const [days, states, sources, uniq, groups] = await db.batch([
      db.prepare(`SELECT acquired_on AS day, COUNT(*) AS count FROM items WHERE ${VISIBLE} GROUP BY acquired_on ORDER BY acquired_on`),
      db.prepare(`SELECT state AS name, COUNT(*) AS count FROM items WHERE ${VISIBLE} AND ${nonEmpty("state")} GROUP BY state ORDER BY count DESC, name`),
      // Leaderboard groups count several exact sources as one contributor.
      db.prepare(
        `SELECT COALESCE(g.contributor, i.acquired_from) AS name, COUNT(*) AS count
         FROM items i LEFT JOIN source_groups g ON g.source = i.acquired_from
         WHERE i.deleted_at IS NULL AND i.status = 'active' AND i.is_demo = 0 AND ${nonEmpty("i.acquired_from")}
         GROUP BY COALESCE(g.contributor, i.acquired_from) COLLATE NOCASE ORDER BY count DESC, name`,
      ),
      // A city is its name within its state, so Springfield, IL and Springfield, MA count twice.
      db.prepare(
        `SELECT COUNT(DISTINCT CASE WHEN ${nonEmpty("city")} THEN lower(city) || '|' || lower(IFNULL(state, '')) END) AS cities,
                COUNT(DISTINCT CASE WHEN ${nonEmpty("country")} THEN lower(country) END) AS countries
         FROM items WHERE ${VISIBLE}`,
      ),
      db.prepare("SELECT source, contributor FROM source_groups ORDER BY contributor, source"),
    ]);
    const u = uniq.results[0] as { cities: number; countries: number };
    const dayRows = days.results as { day: string; count: number }[];
    const body: Insights = {
      total: dayRows.reduce((n, d) => n + d.count, 0),
      goal: Number(await getSetting(db, "goal")) || null,
      days: dayRows,
      states: states.results as unknown as NameCount[],
      sources: sources.results as unknown as NameCount[],
      groups: groups.results as unknown as SourceAlias[],
      unique_states: states.results.length,
      unique_cities: u.cities,
      unique_countries: u.countries,
    };
    c.header("cache-control", "public, max-age=300");
    return c.json(body);
  });

  app.get("/items/:id", async (c) => {
    const id = parseItemId(c.req.param("id"));
    const row = await c.env.DB.prepare("SELECT * FROM items WHERE id = ? AND deleted_at IS NULL AND status = 'active' AND is_demo = 0")
      .bind(id)
      .first<ItemRow>();
    if (!row) throw notFound("Koozie not found");
    const photos = await photosForItem(c.env.DB, id);
    const body: PublicItem = {
      id: row.id,
      code: itemCode(row.id),
      description: row.description,
      color: row.color,
      size: row.size,
      base: row.base,
      city: row.city,
      state: row.state,
      country: row.country,
      visible_text: row.visible_text,
      acquired_from: row.acquired_from,
      acquired_on: row.acquired_on,
      back_same: !!row.back_same,
      photos: photos.map((p) => ({ id: p.id, side: p.side })),
    };
    c.header("cache-control", "public, max-age=60");
    return c.json(body);
  });

  app.get("/photos/:id/:variant", async (c) => {
    const variant = c.req.param("variant");
    if (variant !== "thumb" && variant !== "full") throw notFound();
    // Only photos of koozies a guest can see; scans and bulk uploads waiting for review stay private.
    const photo = await c.env.DB.prepare(
      `SELECT p.full_key, p.thumb_key FROM photos p JOIN items i ON i.id = p.item_id
       WHERE p.id = ? AND i.deleted_at IS NULL AND i.status = 'active' AND i.is_demo = 0`,
    )
      .bind(parsePhotoId(c.req.param("id")))
      .first<{ full_key: string; thumb_key: string }>();
    if (!photo) throw notFound("Photo not found");
    const obj = await c.env.PHOTOS.get(variant === "full" ? photo.full_key : photo.thumb_key);
    if (!obj) throw notFound("Photo file missing");
    return new Response(obj.body, {
      headers: {
        "content-type": "image/jpeg",
        // Not immutable: a koozie deleted later should stop showing within a day.
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
      },
    });
  });

  return app;
}
