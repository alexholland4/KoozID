import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { emptyFields, fakeJpeg, makeClient } from "./helpers";

async function newItem(api: ReturnType<typeof makeClient>, seed: number, description = `Item ${seed}`) {
  const s = await api.scan(seed);
  return (await api.json("POST", "/items", { scan_id: s.body.scan_id, ...emptyFields, description })).body;
}

describe("collection CRUD and count integrity", () => {
  it("edits fields, keeps search text in sync, and validates input", async () => {
    const api = makeClient();
    const item = await newItem(api, 1001, "Blue koozie");
    const upd = await api.json("PATCH", `/items/${item.id}`, { description: "Navy koozie", visible_text: "POLAR PUB / Since 1976" });
    expect(upd.status).toBe(200);
    expect(upd.body.description).toBe("Navy koozie");
    expect((await api.json("GET", "/items?q=polar%20pub")).body.items.map((i: any) => i.id)).toContain(item.id);
    expect((await api.json("GET", "/items?q=blue%20koozie")).body.items.map((i: any) => i.id)).not.toContain(item.id);

    expect((await api.json("PATCH", `/items/${item.id}`, { description: "x".repeat(5000) })).status).toBe(400);
    expect((await api.json("PATCH", `/items/${item.id}`, { status: "bogus" })).status).toBe(400);
    expect((await api.json("PATCH", `/items/${item.id}`, { acquired_on: "yesterday" })).status).toBe(400);
    expect((await api.json("GET", "/items/abc")).status).toBe(400);
    expect((await api.json("GET", "/items/999999")).status).toBe(404);
  });

  it("treats LIKE wildcards in search literally", async () => {
    const api = makeClient();
    await newItem(api, 1101, "100% cotton koozie");
    const r = await api.json("GET", "/items?q=%25");
    expect(r.body.items.every((i: any) => i.description.includes("%"))).toBe(true);
  });

  it("soft delete removes from count and matches; restore brings both back", async () => {
    const api = makeClient();
    const item = await newItem(api, 1201);
    const s0 = (await api.json("GET", "/stats")).body;

    expect((await api.json("DELETE", `/items/${item.id}`)).status).toBe(200);
    const s1 = (await api.json("GET", "/stats")).body;
    expect(s1.total).toBe(s0.total - 1);
    expect(s1.deleted).toBe(s0.deleted + 1);
    const scan = await api.scan(1201);
    expect(scan.body.candidates.map((c: any) => c.item.id)).not.toContain(item.id);
    expect(scan.body.exact_photo_item).toBeNull();
    expect((await api.json("PATCH", `/items/${item.id}`, { description: "x" })).status).toBe(404);
    expect((await api.json("GET", "/items?deleted=1")).body.items.map((i: any) => i.id)).toContain(item.id);

    const restored = await api.json("POST", `/items/${item.id}/restore`);
    expect(restored.body.deleted_at).toBeNull();
    expect((await api.json("GET", "/stats")).body.total).toBe(s0.total);
    const scan2 = await api.scan(1201);
    expect(scan2.body.candidates[0].item.id).toBe(item.id);
  });

  it("purge only works from Recently deleted and removes stored files", async () => {
    const api = makeClient();
    const item = await newItem(api, 1301);
    const photoId = item.photos[0].id;
    expect((await api.json("DELETE", `/items/${item.id}/purge`)).status).toBe(400);
    await api.json("DELETE", `/items/${item.id}`);
    expect((await api.json("DELETE", `/items/${item.id}/purge`)).status).toBe(200);
    expect(await env.PHOTOS.get(`photos/${photoId}/full.jpg`)).toBeNull();
    expect((await api.call("GET", `/photos/${photoId}/thumb`)).status).toBe(404);
    // Catalogue numbers are never reused.
    const next = await newItem(api, 1302);
    expect(next.id).toBeGreaterThan(item.id);
  });

  it("manages photos: serve, set primary, change side, delete", async () => {
    const api = makeClient();
    const item = await newItem(api, 1401);
    const s = await api.scan(1402, false);
    const withTwo = (await api.json("POST", `/items/${item.id}/photos`, { scan_id: s.body.scan_id, side: "back" })).body;
    const [front, back] = withTwo.photos;

    const img = await api.call("GET", `/photos/${back.id}/full`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("cache-control")).toContain("private");
    expect((await api.call("GET", `/photos/${back.id}/full`, undefined, { "if-none-match": img.headers.get("etag")! })).status).toBe(304);
    expect((await api.call("GET", `/photos/${back.id}/huge`)).status).toBe(404);

    const primary = (await api.json("PATCH", `/photos/${back.id}`, { primary: true })).body;
    expect(primary.photos[0].id).toBe(back.id);
    const sided = (await api.json("PATCH", `/photos/${front.id}`, { side: "other" })).body;
    expect(sided.photos.find((p: any) => p.id === front.id).side).toBe("other");

    const after = (await api.json("DELETE", `/photos/${front.id}`)).body;
    expect(after.photos.map((p: any) => p.id)).toEqual([back.id]);
  });

  it("handles a photo file missing from storage without corrupting the record", async () => {
    const api = makeClient();
    const item = await newItem(api, 1501);
    await env.PHOTOS.delete(`photos/${item.photos[0].id}/thumb.jpg`);
    expect((await api.call("GET", `/photos/${item.photos[0].id}/thumb`)).status).toBe(404);
    expect((await api.json("GET", `/items/${item.id}`)).status).toBe(200);
  });

  it("re-embeds photos when the embedding model changes, without losing items", async () => {
    const api = makeClient();
    const item = await newItem(api, 1601);
    const api2 = makeClient({}, { EMBEDDING_DIMS: "256" }); // simulates a provider/dimension change
    let r: any;
    r = (await api2.json("POST", "/admin/reindex", { limit: 50, reset: true })).body;
    while (r.remaining > 0 && r.embedded + r.indexed > 0) r = (await api2.json("POST", "/admin/reindex", { limit: 50 })).body;
    expect(r.remaining).toBe(0);
    expect(r.failed).toBe(0);
    const scan = await api2.scan(1601);
    expect(scan.body.candidates[0].item.id).toBe(item.id);
    expect((await api2.json("GET", `/items/${item.id}`)).body.description).toBe("Item 1601");
  });
});

describe("upload validation", () => {
  const api = makeClient();
  const post = (full: Blob | null, thumb: Blob | null) => {
    const fd = new FormData();
    if (full) fd.set("full", full);
    if (thumb) fd.set("thumb", thumb);
    return api.json("POST", "/scans", fd);
  };
  const thumb = () => new Blob([fakeJpeg(200, 250, 5, 64)]);

  it("rejects non-JPEG content even when labelled as JPEG", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const r = await post(new Blob([png], { type: "image/jpeg" }), thumb());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_image");
  });

  it("rejects missing, empty, oversized and out-of-range images", async () => {
    expect((await post(null, thumb())).status).toBe(400);
    expect((await post(new Blob([]), thumb())).status).toBe(400);
    const big = await post(new Blob([fakeJpeg(800, 800, 1, 6 * 1024 * 1024)]), thumb());
    expect(big.status).toBe(400);
    expect(big.body.error.code).toBe("image_too_large");
    expect((await post(new Blob([fakeJpeg(9000, 100, 1)]), thumb())).status).toBe(400);
    expect((await post(new Blob([fakeJpeg(800, 800, 1)]), null)).status).toBe(400);
  });

  it("rejects non-multipart bodies and bad ids", async () => {
    expect((await api.json("POST", "/scans", { full: "x" })).status).toBe(400);
    expect((await api.json("POST", "/scans/not-a-uuid/describe")).status).toBe(400);
    expect((await api.json("POST", "/items", { scan_id: crypto.randomUUID(), ...emptyFields })).status).toBe(404);
  });
});
