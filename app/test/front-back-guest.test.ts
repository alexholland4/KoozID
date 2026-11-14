import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDeps } from "../src/worker/app";
import { dailyMaintenance } from "../src/worker/catalog";
import { getConfig, type Env } from "../src/worker/env";
import worker from "../src/worker/index";
import { jpegFile, makeClient } from "./helpers";

const fields = { description: "Front and back test koozie (red)", size: "Standard Can", acquired_from: "Uncle Joe", notes: "private note" };

/** Requests through the real entry point, as the browser would. */
async function site(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://localhost${path}`, init) as Parameters<typeof worker.fetch>[0], env as unknown as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("front and back photos", () => {
  it("saves both sides from one scan, the back indexed in the background", async () => {
    const api = makeClient();
    const front = (await api.scan(8001)).body.scan_id;
    const back = (await api.scan(8002, false)).body.scan_id;
    const res = await api.json("POST", "/items", { ...fields, scan_id: front, side: "front", back_scan_id: back });
    expect(res.status).toBe(201);
    expect(res.body.photos.map((p: any) => p.side)).toEqual(["front", "back"]);
    expect(res.body.back_same).toBe(false);
    const item = (await api.json("GET", `/items/${res.body.id}`)).body;
    expect(item.photos.every((p: any) => p.indexed)).toBe(true);
  });

  it("records 'same as front' and clears it once a real back photo is added", async () => {
    const api = makeClient();
    const front = (await api.scan(8101)).body.scan_id;
    const res = await api.json("POST", "/items", { ...fields, scan_id: front, side: "front", back_same: true });
    expect(res.body.back_same).toBe(true);
    expect(res.body.photos).toHaveLength(1);

    const back = (await api.scan(8102, false)).body.scan_id;
    const after = await api.json("POST", `/items/${res.body.id}/photos`, { scan_id: back, side: "back", background: true });
    expect(after.body.back_same).toBe(false);

    const patched = await api.json("PATCH", `/items/${res.body.id}`, { back_same: true });
    expect(patched.body.back_same).toBe(true);
  });
});

describe("guest view", () => {
  it("shows counted koozies and their source, but not notes", async () => {
    const api = makeClient();
    const front = (await api.scan(8201)).body.scan_id;
    const item = (await api.json("POST", "/items", { ...fields, description: "Guest visible koozie", scan_id: front, side: "front" })).body;
    const pending = (await api.scan(8202)).body.scan_id;
    const review = (await api.json("POST", "/items", { ...fields, description: "Guest hidden review koozie", scan_id: pending, side: "front", status: "needs_review" })).body;

    const stats = await site("/pub/stats");
    expect(stats.status).toBe(200);
    const s = (await stats.json()) as any;
    expect(s.total).toBeGreaterThan(0);
    expect(Object.keys(s).sort()).toEqual(["goal", "last_90_days", "total"]);

    const list = (await (await site("/pub/items?q=guest")).json()) as any;
    expect(list.items.map((i: any) => i.id)).toContain(item.id);
    expect(list.items.map((i: any) => i.id)).not.toContain(review.id);
    expect(list.items.find((i: any) => i.id === item.id).acquired_from).toBe("Uncle Joe");

    const detail = (await (await site(`/pub/items/${item.id}`)).json()) as any;
    expect(detail.description).toBe("Guest visible koozie");
    expect(detail.acquired_from).toBe("Uncle Joe");
    expect(detail).not.toHaveProperty("notes");
    expect(detail).not.toHaveProperty("review_note");
    expect((await site(`/pub/items/${review.id}`)).status).toBe(404);

    expect((await site(`/pub/photos/${detail.photos[0].id}/thumb`)).status).toBe(200);
    // Photos of hidden koozies and unsaved scans aren't served.
    expect((await site(`/pub/photos/${review.photos[0].id}/thumb`)).status).toBe(404);
    const scanOnly = (await api.scan(8203, false)).body.scan_id;
    expect((await site(`/pub/photos/${scanOnly}/full`)).status).toBe(404);
  });

  it("filters by source, picks a random koozie and reports stats", async () => {
    const api = makeClient();
    for (const [seed, state, city] of [[8301, "Wisconsin", "Madison"], [8302, "Wisconsin", "Milwaukee"], [8303, "Ohio", "Akron"]] as const) {
      const scan = (await api.scan(seed)).body.scan_id;
      await api.json("POST", "/items", { ...fields, acquired_from: "Gift from Stats Tester", state, city, scan_id: scan, side: "front", acquired_on: "2025-03-04" });
    }
    const mine = (await (await site(`/pub/items?source=${encodeURIComponent("gift from stats tester")}`)).json()) as any;
    expect(mine.total).toBe(3);

    const r = await site("/pub/random");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(((await r.json()) as any).id).toBeGreaterThan(0);

    const ins = (await (await site("/pub/insights")).json()) as any;
    expect(ins.sources.find((x: any) => x.name === "Gift from Stats Tester").count).toBe(3);
    expect(ins.states.find((x: any) => x.name === "Wisconsin").count).toBeGreaterThanOrEqual(2);
    expect(ins.days.find((d: any) => d.day === "2025-03-04").count).toBeGreaterThanOrEqual(3);
    expect(ins.unique_cities).toBeGreaterThanOrEqual(3);
    expect(ins.total).toBe(ins.days.reduce((n: number, d: any) => n + d.count, 0));
  });

  it("is read-only and /signin lands on the home page", async () => {
    expect((await site("/pub/items", { method: "POST" })).status).toBe(405);
    const res = await site("/signin");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost/");
  });
});

describe("photo cleanup", () => {
  it("erases koozies 30 days after deletion, with their photos, and abandoned scans", async () => {
    const api = makeClient();
    const e = env as unknown as Env;
    const scan = (await api.scan(8401)).body.scan_id;
    const item = (await api.json("POST", "/items", { ...fields, scan_id: scan, side: "front" })).body;
    await api.json("DELETE", `/items/${item.id}`);
    const fresh = (await api.json("POST", "/items", { ...fields, scan_id: (await api.scan(8402)).body.scan_id, side: "front" })).body;
    await api.json("DELETE", `/items/${fresh.id}`);
    const stray = (await api.scan(8403, false)).body.scan_id;
    const key = (await e.DB.prepare("SELECT full_key FROM photos WHERE id = ?").bind(scan).first<{ full_key: string }>())!.full_key;
    expect(await e.PHOTOS.head(key)).not.toBeNull();
    await e.DB.prepare("UPDATE items SET deleted_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(item.id).run();
    await e.DB.prepare("UPDATE photos SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(stray).run();

    const res = await dailyMaintenance(createDeps(e, getConfig(e), {}, () => {}));
    expect(res.purged).toBeGreaterThanOrEqual(1);
    expect(res.scans).toBeGreaterThanOrEqual(1);
    expect(await e.DB.prepare("SELECT 1 FROM items WHERE id = ?").bind(item.id).first()).toBeNull();
    expect(await e.DB.prepare("SELECT 1 FROM photos WHERE id IN (?, ?)").bind(scan, stray).first()).toBeNull();
    expect(await e.PHOTOS.head(key)).toBeNull();
    // Deleted less than 30 days ago: still restorable, photo intact.
    expect((await api.json("POST", `/items/${fresh.id}/restore`)).body.photos).toHaveLength(1);
  });
});

describe("column sorting", () => {
  it("sorts by any spreadsheet column, blanks last in both directions", async () => {
    const api = makeClient();
    for (const [seed, color] of [[8501, "zz-teal"], [8502, null], [8503, "aa-amber"]] as const) {
      const scan = (await api.scan(seed)).body.scan_id;
      await api.json("POST", "/items", { ...fields, color, acquired_from: "Sort Tester", scan_id: scan, side: "front" });
    }
    const colors = async (order: string) =>
      ((await (await site(`/pub/items?source=Sort%20Tester&sort=color&order=${order}`)).json()) as any).items.map((i: any) => i.color);
    expect(await colors("asc")).toEqual(["aa-amber", "zz-teal", null]);
    expect(await colors("desc")).toEqual(["zz-teal", "aa-amber", null]);
    // Guests can't sort by edit date; it falls back to newest first.
    expect((await site("/pub/items?sort=updated")).status).toBe(200);
  });
});

describe("guest extras", () => {
  it("serves a random sample, on-this-day groups, and a photo check that stores nothing", async () => {
    const api = makeClient();
    const scan = (await api.scan(8601)).body.scan_id;
    const item = (await api.json("POST", "/items", { ...fields, scan_id: scan, side: "front", acquired_on: "2025-06-15" })).body;

    const sample = (await (await site("/pub/sample?n=5")).json()) as any;
    expect(sample.items.length).toBeGreaterThan(0);
    expect(sample.items.length).toBeLessThanOrEqual(5);

    const otd = (await (await site("/pub/on-this-day?date=2026-06-15")).json()) as any;
    const yearAgo = otd.groups.find((g: any) => g.label === "A year ago today");
    expect(yearAgo.date).toBe("2025-06-15");
    expect(yearAgo.items.map((i: any) => i.id)).toContain(item.id);
    expect((await site("/pub/on-this-day?date=nope")).status).toBe(400);

    const photo = (n: number) => {
      const fd = new FormData();
      fd.set("photo", jpegFile(n));
      return fd;
    };
    // The custom header is required, so another site can't post photos on a visitor's behalf.
    expect((await site("/pub/check", { method: "POST", body: photo(8601) })).status).toBe(403);
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>())!.n;
    const same = (await (await site("/pub/check", { method: "POST", body: photo(8601), headers: { "x-koozid": "1" } })).json()) as any;
    expect(same.verdict).toBe("have");
    expect(same.matches[0].item.id).toBe(item.id);
    const other = (await (await site("/pub/check", { method: "POST", body: photo(8699), headers: { "x-koozid": "1" } })).json()) as any;
    expect(["new", "maybe"]).toContain(other.verdict);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>())!.n).toBe(before);
  });
});

describe("contribute page", () => {
  it("admins set the wish list, picks and a private address; guests read only the public parts; unsafe links are refused", async () => {
    const api = makeClient();
    const initial = (await (await site("/pub/contribute")).json()) as any;
    // The collector's wish list ships with the migration.
    expect(initial.wishlist_url).toContain("amazon.com/hz/wishlist");

    expect((await api.json("PUT", "/admin/contribute", { mailing_address: "Bobby\n1 Koozie Ln", wishlist_url: "https://www.amazon.com/hz/wishlist/ls/ABC" })).status).toBe(200);
    expect((await api.json("PUT", "/admin/contribute", { wishlist_url: "javascript:alert(1)" })).status).toBe(400);
    expect((await api.json("POST", "/admin/wishlist", { title: "Pickle koozie", url: "data:text/html,hi" })).status).toBe(400);
    const added = await api.json("POST", "/admin/wishlist", { title: "Pickle koozie", url: "https://www.amazon.com/dp/B000", note: "Very funny" });
    expect(added.status).toBe(201);

    const info = (await (await site("/pub/contribute")).json()) as any;
    expect(info).toMatchObject({ wishlist_url: "https://www.amazon.com/hz/wishlist/ls/ABC" });
    expect(JSON.stringify(info)).not.toContain("Koozie Ln");
    expect((await api.json("GET", "/admin/contribute")).body.mailing_address).toBe("Bobby\n1 Koozie Ln");
    expect(info.items.map((w: any) => w.title)).toContain("Pickle koozie");
    const id = info.items.find((w: any) => w.title === "Pickle koozie").id;
    expect((await api.json("DELETE", `/admin/wishlist/${id}`)).body.items.some((w: any) => w.id === id)).toBe(false);
  });
});
