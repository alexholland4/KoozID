// HTTP API. Everything under /api requires an authenticated identity (Cloudflare Access guards
// /api and /signin; the guest view in public.ts is separate). Static assets are public and are
// served by Workers Static Assets without invoking this code.

import { Hono } from "hono";
import type { Me, Stats } from "../shared/types";
import { GeminiDescriber, GeminiEmbedder, GeminiMatcher } from "./ai/gemini";
import { MockDescriber, MockEmbedder, MockMatcher } from "./ai/mock";
import type { Describer, Embedder, Matcher } from "./ai/types";
import * as bulk from "./bulk";
import { authenticate, type Identity, type KeyFetcher } from "./auth";
import * as catalog from "./catalog";
import { addWish, deleteWish, getContributeAdmin, setContribute } from "./contribute";
import { testEmail } from "./emails";
import { EMAIL_RE } from "../shared/contribute";
import * as offers from "./contributions";
import { createMailer, type Mailer } from "./mail";
import {
  fieldValues,
  getItem,
  getPhoto,
  getSetting,
  listItems,
  rowToItem,
  setSetting,
  stats,
  today,
  updateItem,
  type ItemRow,
  type PhotoRow,
  SORT_KEYS,
  type SortKey,
} from "./db";
import { getConfig, type Config, type Env } from "./env";
import { badRequest, errorBody, forbidden, HttpError, notFound } from "./errors";
import { createIndex } from "./search";
import {
  jsonBody,
  optionalNote,
  parseDate,
  parseFields,
  parseItemId,
  parsePhotoId,
  parseSide,
  parseStatus,
} from "./validation";

type Vars = { deps: catalog.Deps; identity: Identity; cfg: Config };
export type AppEnv = { Bindings: Env; Variables: Vars };

/** Overridable factories, so tests can inject failing or fake providers. */
export interface AppOptions {
  embedder?: (cfg: Config) => Embedder;
  describer?: (cfg: Config) => Describer;
  matcher?: (cfg: Config) => Matcher;
  mailer?: (cfg: Config) => Mailer;
  keyFetcher?: KeyFetcher;
}

export function defaultEmbedder(cfg: Config): Embedder {
  return cfg.aiProvider === "mock"
    ? new MockEmbedder(cfg.embeddingDims)
    : new GeminiEmbedder(cfg.geminiApiKey, cfg.embeddingModel, cfg.embeddingDims);
}

export function defaultDescriber(cfg: Config): Describer {
  return cfg.aiProvider === "mock" ? new MockDescriber() : new GeminiDescriber(cfg.geminiApiKey, cfg.describeModels);
}

export function defaultMatcher(cfg: Config): Matcher {
  return cfg.aiProvider === "mock" ? new MockMatcher() : new GeminiMatcher(cfg.geminiApiKey, cfg.describeModels);
}

/** Per-request (or per-cron-run) dependencies. `defer` keeps work running after the response. */
export function createDeps(env: Env, cfg: Config, opts: AppOptions, defer: (p: Promise<unknown>) => void): catalog.Deps {
  const embedder = (opts.embedder ?? defaultEmbedder)(cfg);
  return {
    db: env.DB,
    bucket: env.PHOTOS,
    cfg,
    embedder,
    describer: (opts.describer ?? defaultDescriber)(cfg),
    matcher: (opts.matcher ?? defaultMatcher)(cfg),
    index: createIndex(env, cfg, embedder.modelId),
    defer,
  };
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono<AppEnv>().basePath("/api");

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.message), err.status as 400);
    console.error("unhandled", err);
    return c.json(errorBody("internal", "Something went wrong. Please try again."), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", "Unknown endpoint"), 404));

  // Authentication, CSRF guard, and per-request dependencies.
  app.use("*", async (c, next) => {
    const cfg = getConfig(c.env);
    const identity = await authenticate(c.req.raw, cfg, opts.keyFetcher);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      // Cross-site forms cannot set custom headers, and we never enable CORS.
      if (c.req.header("x-koozid") !== "1") throw forbidden("Missing request header");
    }
    c.set("cfg", cfg);
    c.set("identity", identity);
    c.set(
      "deps",
      createDeps(c.env, cfg, opts, (p) => {
        try {
          c.executionCtx.waitUntil(p.catch((e) => console.warn("deferred task failed", e)));
        } catch {
          p.catch(() => {});
        }
      }),
    );
    await next();
    c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
  });

  const requireAdmin = (c: { get(k: "identity"): Identity }) => {
    if (!c.get("identity").isAdmin) throw forbidden("Admin only");
  };

  // ------------------------------------------------------------------ session & stats

  app.get("/me", (c) => {
    const cfg = c.get("cfg");
    const me: Me = {
      email: c.get("identity").email,
      is_admin: c.get("identity").isAdmin,
      auth_mode: cfg.authMode,
      ai_provider: cfg.aiProvider === "mock" ? "mock" : `gemini (${cfg.embeddingModel}, ${cfg.describeModels.join(" → ")})`,
      vector_backend: cfg.vectorBackend,
    };
    return c.json(me);
  });

  app.get("/stats", async (c) => {
    const db = c.env.DB;
    const [s, recent, goal] = await Promise.all([stats(db), listItems(db, { sort: "id", order: "desc", limit: 8 }), getSetting(db, "goal")]);
    const body: Stats = { ...s, goal: goal ? Number(goal) : null, recent: recent.items };
    return c.json(body);
  });

  app.get("/values", async (c) => c.json(await fieldValues(c.env.DB)));

  // ------------------------------------------------------------------ scan flow

  app.post("/scans", async (c) => {
    const form = await c.req.formData().catch(() => {
      throw badRequest("Expected multipart form data");
    });
    const res = await catalog.createScan(c.get("deps"), {
      full: form.get("full"),
      thumb: form.get("thumb"),
      originalName: (form.get("name") as string | null) ?? null,
      search: form.get("search") !== "0",
    });
    return c.json(res, 201);
  });

  app.post("/scans/:id/describe", async (c) => {
    // The back photo is optional; its printed text is read too.
    const back = c.req.query("back");
    return c.json(await catalog.describeScan(c.get("deps"), parsePhotoId(c.req.param("id")), back ? parsePhotoId(back) : undefined));
  });

  // ------------------------------------------------------------------ items

  app.post("/items", async (c) => {
    const body = await jsonBody(c.req.raw);
    const fields = parseFields(body, false) as Required<ReturnType<typeof parseFields>>;
    const status = parseStatus(body.status) ?? "active";
    const d = c.get("deps");
    const front = await catalog.saveScanAsItem(d, {
      scanId: parsePhotoId(body.scan_id),
      fields,
      status,
      reviewNote: status === "needs_review" ? optionalNote(body.review_note) : null,
      side: parseSide(body.side),
      acquiredOn: parseDate(body.acquired_on),
    });
    // The scan flow photographs both sides. The back is indexed after responding, from the bulk
    // quota, so a koozie costs the interactive quota only for its front search and description.
    let item = front;
    if (body.back_scan_id !== undefined && body.back_scan_id !== null) {
      item = await catalog.attachScanToItem(d, front.id, parsePhotoId(body.back_scan_id), "back", { deferIndex: true });
    } else if (body.back_same === true && !front.back_same) {
      item = (await updateItem(d.db, front.id, { back_same: true }))!;
    }
    return c.json(item, 201);
  });

  app.get("/items", async (c) => {
    const q = c.req.query();
    const sort = ((SORT_KEYS as readonly string[]).includes(q.sort) ? q.sort : "acquired") as SortKey;
    const status = q.status === "active" || q.status === "needs_review" ? q.status : "all";
    const limit = Number(q.limit) || 48;
    const offset = Number(q.offset) || 0;
    const res = await listItems(c.env.DB, {
      q: q.q?.slice(0, 200),
      status,
      noPhoto: q.photo === "none",
      sort,
      order: q.order === "asc" ? "asc" : "desc",
      offset,
      limit,
      deleted: q.deleted === "1",
      source: q.source?.slice(0, 200) || undefined,
    });
    const next = offset + res.items.length;
    return c.json({ ...res, next_offset: next < res.total ? next : null });
  });

  app.get("/items/:id", async (c) => {
    const item = await getItem(c.env.DB, parseItemId(c.req.param("id")));
    if (!item) throw notFound("Item not found");
    return c.json(item);
  });

  app.patch("/items/:id", async (c) => {
    const id = parseItemId(c.req.param("id"));
    const body = await jsonBody(c.req.raw);
    const patch = {
      ...parseFields(body, true),
      ...(body.status !== undefined ? { status: parseStatus(body.status) } : {}),
      ...("review_note" in body ? { review_note: optionalNote(body.review_note) } : {}),
      ...(body.acquired_on !== undefined ? { acquired_on: parseDate(body.acquired_on) } : {}),
      ...(body.back_same !== undefined ? { back_same: body.back_same === true } : {}),
    };
    const item = await updateItem(c.env.DB, id, patch);
    if (!item) throw notFound("Item not found");
    return c.json(item);
  });

  app.delete("/items/:id", async (c) => {
    await catalog.softDeleteItem(c.get("deps"), parseItemId(c.req.param("id")));
    return c.json({ ok: true });
  });

  app.post("/items/:id/restore", async (c) => {
    return c.json(await catalog.restoreItem(c.get("deps"), parseItemId(c.req.param("id"))));
  });

  app.delete("/items/:id/purge", async (c) => {
    await catalog.purgeItem(c.get("deps"), parseItemId(c.req.param("id")));
    return c.json({ ok: true });
  });

  app.post("/items/:id/photos", async (c) => {
    const body = await jsonBody(c.req.raw);
    const item = await catalog.attachScanToItem(
      c.get("deps"),
      parseItemId(c.req.param("id")),
      parsePhotoId(body.scan_id),
      parseSide(body.side),
      // The scan flow attaches both sides at once and doesn't wait for indexing.
      { deferIndex: body.background === true },
    );
    return c.json(item, 201);
  });

  // ------------------------------------------------------------------ photos

  app.patch("/photos/:id", async (c) => {
    const body = await jsonBody(c.req.raw);
    return c.json(
      await catalog.updatePhoto(c.get("deps"), parsePhotoId(c.req.param("id")), {
        side: body.side !== undefined ? parseSide(body.side) : undefined,
        primary: body.primary === true,
      }),
    );
  });

  app.delete("/photos/:id", async (c) => {
    return c.json(await catalog.deletePhoto(c.get("deps"), parsePhotoId(c.req.param("id"))));
  });

  app.get("/photos/:id/:variant", async (c) => {
    const variant = c.req.param("variant");
    if (variant !== "thumb" && variant !== "full") throw notFound();
    const photo = await getPhoto(c.env.DB, parsePhotoId(c.req.param("id")));
    if (!photo) throw notFound("Photo not found");
    const etag = `"${photo.id}-${variant}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    const obj = await c.env.PHOTOS.get(variant === "full" ? photo.full_key : photo.thumb_key);
    if (!obj) throw notFound("Photo file missing");
    return new Response(obj.body, {
      headers: {
        "content-type": "image/jpeg",
        // Photo objects are immutable (new photo = new id). "private" keeps shared caches out.
        "cache-control": "private, max-age=31536000, immutable",
        etag,
        "x-content-type-options": "nosniff",
      },
    });
  });

  // ------------------------------------------------------------------ export (paged; the client builds CSV/ZIP)

  app.get("/export/items", async (c) => {
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
    const includeDeleted = c.req.query("deleted") === "1";
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM items ${includeDeleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY id LIMIT ? OFFSET ?`,
    )
      .bind(limit, offset)
      .all<ItemRow>();
    const ids = results.map((r) => r.id);
    const photos = ids.length
      ? (
          await c.env.DB.prepare(
            `SELECT id, item_id, side, position, width, height, indexed, embed_error, created_at, full_key, thumb_key, bytes, sha256,
                    original_name, embedding_model, NULL AS embedding
             FROM photos WHERE item_id IN (${ids.map(() => "?").join(",")}) ORDER BY item_id, position, created_at`,
          )
            .bind(...ids)
            .all<PhotoRow>()
        ).results
      : [];
    const items = results.map((r) => rowToItem(r, photos.filter((p) => p.item_id === r.id)));
    return c.json({ items, next_offset: results.length === limit ? offset + limit : null, exported_at: new Date().toISOString() });
  });

  // ------------------------------------------------------------------ bulk photo matching
  // Uploading and matching are admin tools; reviewing is open to every signed-in user.

  app.post("/admin/bulk/photos", async (c) => {
    requireAdmin(c);
    const form = await c.req.formData().catch(() => {
      throw badRequest("Expected multipart form data");
    });
    const name = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : null;
    };
    // Optional back_full/back_thumb: the same koozie's back, kept with its front.
    const back = form.has("back_full") ? { full: form.get("back_full"), thumb: form.get("back_thumb"), name: name("back_name") } : undefined;
    return c.json(await bulk.bulkUpload(c.get("deps"), { full: form.get("full"), thumb: form.get("thumb"), name: name("name"), back }), 201);
  });

  app.post("/admin/bulk/photos/:id/match", async (c) => {
    requireAdmin(c);
    return c.json(await bulk.bulkMatch(c.get("deps"), parsePhotoId(c.req.param("id"))));
  });

  app.get("/bulk", async (c) => {
    return c.json(await bulk.bulkQueue(c.get("deps"), { pending: c.req.query("status") === "pending", limit: Number(c.req.query("limit")) || 30 }));
  });

  app.post("/bulk/:id/accept", async (c) => {
    const body = await jsonBody(c.req.raw);
    return c.json(await bulk.bulkAccept(c.get("deps"), parsePhotoId(c.req.param("id")), parseItemId(String(body.item_id))));
  });

  app.post("/bulk/:id/new", async (c) => {
    const body = await jsonBody(c.req.raw);
    const fields = parseFields(body, false) as Required<ReturnType<typeof parseFields>>;
    return c.json(await bulk.bulkCreate(c.get("deps"), parsePhotoId(c.req.param("id")), fields, parseDate(body.acquired_on)), 201);
  });

  app.post("/bulk/:id/skip", async (c) => {
    await bulk.bulkSkip(c.get("deps"), parsePhotoId(c.req.param("id")));
    return c.json({ ok: true });
  });

  app.delete("/bulk/:id", async (c) => {
    await bulk.bulkDiscard(c.get("deps"), parsePhotoId(c.req.param("id")));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ admin

  app.post("/admin/import", async (c) => {
    requireAdmin(c);
    const form = await c.req.formData().catch(() => {
      throw badRequest("Expected multipart form data");
    });
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(String(form.get("meta") ?? ""));
    } catch {
      throw badRequest("meta must be JSON");
    }
    const fields = parseFields(meta, false) as Required<ReturnType<typeof parseFields>>;
    const extra = meta.extra && typeof meta.extra === "object" ? JSON.stringify(meta.extra).slice(0, 8000) : null;
    const ref = typeof meta.external_ref === "string" && meta.external_ref.trim() ? meta.external_ref.trim().slice(0, 200) : null;
    const photos: { full: unknown; thumb: unknown; name: string | null }[] = [];
    const sides: ReturnType<typeof parseSide>[] = [];
    for (let i = 0; form.has(`full_${i}`); i++) {
      photos.push({ full: form.get(`full_${i}`), thumb: form.get(`thumb_${i}`), name: (form.get(`name_${i}`) as string) ?? null });
      sides.push(parseSide(form.get(`side_${i}`)));
    }
    const num = Number(meta.number);
    const res = await catalog.importItem(
      c.get("deps"),
      {
        externalRef: ref,
        number: Number.isSafeInteger(num) && num > 0 ? num : null,
        fields,
        acquiredOn: parseDate(meta.acquired_on) ?? today(),
        extraJson: extra,
        isDemo: meta.demo === true,
        sides,
      },
      photos,
    );
    return c.json(res, res.status === "created" ? 201 : 200);
  });

  app.post("/admin/reindex", async (c) => {
    requireAdmin(c);
    const body = await jsonBody(c.req.raw).catch(() => ({}) as Record<string, unknown>);
    return c.json(await catalog.reindex(c.get("deps"), Number(body.limit) || 10, body.reset === true));
  });

  app.post("/admin/demo/purge", async (c) => {
    requireAdmin(c);
    return c.json(await catalog.purgeDemo(c.get("deps")));
  });

  app.put("/admin/settings", async (c) => {
    const body = await jsonBody(c.req.raw);
    if ("goal" in body) {
      const g = body.goal === null || body.goal === "" ? null : Number(body.goal);
      if (g !== null && (!Number.isInteger(g) || g < 1 || g > 10_000_000)) throw badRequest("Goal must be a whole number");
      await setSetting(c.env.DB, "goal", g === null ? null : String(g));
    }
    return c.json({ goal: Number(await getSetting(c.env.DB, "goal")) || null });
  });

  // Collector tools (goal above, contribute settings, offers, leaderboard groups) are open to every
  // signed-in member, not only ADMIN_EMAILS: the collector runs them. Members are already limited to
  // ALLOWED_EMAILS behind Access. Import, reindex, demo cleanup and usage stay admin-only.

  // Contribute page: the wish list and featured picks (public) and the mailing address (private).
  // Each change clears the public page's edge-cached copy so visitors see it straight away.
  const clearEdge = async (url: string, ...paths: string[]) => {
    for (const p of paths) {
      try {
        await (caches as unknown as { default: Cache }).default.delete(new Request(new URL(p, url)));
      } catch {
        // No edge cache (local dev, tests).
      }
    }
  };
  const mailer = (c: { get(k: "cfg"): Config }) => (opts.mailer ?? createMailer)(c.get("cfg"));
  const contributeAdmin = async (c: { req: { url: string }; env: Env; get(k: "cfg"): Config }) => {
    await clearEdge(c.req.url, "/pub/contribute");
    return getContributeAdmin(c.env.DB, mailer(c).enabled);
  };

  app.get("/admin/contribute", async (c) => {
    return c.json(await getContributeAdmin(c.env.DB, mailer(c).enabled));
  });

  // Sends a test email to whoever is signed in and reports the provider's own error, for setup.
  app.post("/admin/email-test", async (c) => {
    const m = mailer(c);
    if (!m.enabled) return c.json({ sent: false, error: "Email isn't connected: set EMAIL_PROVIDER and the RESEND_API_KEY secret" });
    const to = c.get("identity").email;
    if (!EMAIL_RE.test(to)) throw badRequest("Sign in with an email address to send a test");
    try {
      await m.send(testEmail(to, base(c)));
      return c.json({ sent: true, to });
    } catch (e) {
      return c.json({ sent: false, to, error: (e as Error).message });
    }
  });

  app.put("/admin/contribute", async (c) => {
    await setContribute(c.env.DB, await jsonBody(c.req.raw));
    return c.json(await contributeAdmin(c));
  });

  app.post("/admin/wishlist", async (c) => {
    await addWish(c.env.DB, await jsonBody(c.req.raw));
    return c.json(await contributeAdmin(c), 201);
  });

  app.delete("/admin/wishlist/:id", async (c) => {
    await deleteWish(c.env.DB, parseItemId(c.req.param("id")));
    return c.json(await contributeAdmin(c));
  });

  // Koozie offers from visitors: approve (emails the mailing address), decline, thank on arrival.
  const base = (c: { req: { url: string } }) => new URL(c.req.url).origin;

  app.get("/admin/offers", async (c) => {
    const which = c.req.query("status");
    const tab = which === "approved" || which === "done" ? which : "new";
    const [list, counts] = await Promise.all([offers.listOffers(c.env.DB, tab), offers.offerCounts(c.env.DB)]);
    return c.json({ offers: list, counts, email_enabled: mailer(c).enabled });
  });

  app.post("/admin/offers/:id/:action", async (c) => {
    const id = parseItemId(c.req.param("id"));
    const db = c.env.DB;
    switch (c.req.param("action")) {
      case "approve":
        return c.json(await offers.approveOffer(db, mailer(c), id, base(c)));
      case "decline":
        return c.json(await offers.declineOffer(db, id));
      case "reopen":
        return c.json(await offers.reopenOffer(db, id));
      case "thank":
        return c.json(await offers.thankOffer(db, mailer(c), id, (await jsonBody(c.req.raw)).item_ids, base(c)));
      case "resend":
        return c.json(await offers.resendOffer(db, mailer(c), id, base(c)));
      default:
        throw notFound();
    }
  });

  // Leaderboard groups: several exact sources counted as one contributor.
  app.get("/admin/sources", async (c) => {
    return c.json({ sources: await offers.listSources(c.env.DB) });
  });

  app.put("/admin/source-groups", async (c) => {
    await offers.groupSources(c.env.DB, await jsonBody(c.req.raw));
    await clearEdge(c.req.url, "/pub/insights");
    return c.json({ sources: await offers.listSources(c.env.DB) });
  });

  app.delete("/admin/source-groups", async (c) => {
    await offers.ungroupSources(c.env.DB, await jsonBody(c.req.raw));
    await clearEdge(c.req.url, "/pub/insights");
    return c.json({ sources: await offers.listSources(c.env.DB) });
  });

  app.get("/admin/usage", async (c) => {
    requireAdmin(c);
    const { results } = await c.env.DB.prepare("SELECT * FROM ai_usage ORDER BY day DESC LIMIT 30").all();
    return c.json({ usage: results });
  });

  return app;
}
