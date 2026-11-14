import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { fakeJpeg, makeClient } from "./helpers";

// The mock matcher picks the record whose description shares words with the photo's file name.
const upload = async (api: ReturnType<typeof makeClient>, seed: number, name: string) => {
  const fd = new FormData();
  fd.set("full", new Blob([fakeJpeg(800, 1000, seed)]));
  fd.set("thumb", new Blob([fakeJpeg(240, 300, seed, 256)]));
  fd.set("name", name);
  return api.json("POST", "/admin/bulk/photos", fd);
};

const record = async (api: ReturnType<typeof makeClient>, ref: string, description: string) => {
  const fd = new FormData();
  fd.set("meta", JSON.stringify({ external_ref: ref, description, size: "Standard Can" }));
  return (await api.json("POST", "/admin/import", fd)).body.id as number;
};

describe("bulk photo matching", () => {
  it("suggests a record, and accepting it attaches and indexes the photo", async () => {
    const api = makeClient();
    const harpoon = await record(api, "bulk:harpoon", "Harpoon IPA employee owned orange diamond (blue)");
    await record(api, "bulk:other", "Trillium text only (light green)");

    const up = await upload(api, 7001, "harpoon-ipa-employee.jpg");
    expect(up.status).toBe(201);
    expect(up.body.status).toBe("queued");
    // The same file again is recognised and dropped.
    expect((await upload(api, 7001, "copy.jpg")).body.status).toBe("duplicate");

    const m = await api.json("POST", `/admin/bulk/photos/${up.body.photo_id}/match`);
    expect(m.body).toMatchObject({ status: "suggested", confidence: "high", item: { id: harpoon } });

    const q = (await api.json("GET", "/bulk")).body;
    expect(q.items.map((b: any) => b.photo_id)).toContain(up.body.photo_id);
    expect((await api.json("GET", "/stats")).body.bulk_review).toBeGreaterThanOrEqual(1);

    const acc = await api.json("POST", `/bulk/${up.body.photo_id}/accept`, { item_id: harpoon });
    expect(acc.status).toBe(200);
    expect(acc.body.photos).toHaveLength(1);
    expect(acc.body.photos[0].side).toBe("front");
    expect((await api.json("GET", `/items/${harpoon}`)).body.photos[0].indexed).toBe(true);
    // Gone from the queue; a second photo of the same koozie becomes its back.
    expect((await api.json("POST", `/bulk/${up.body.photo_id}/accept`, { item_id: harpoon })).status).toBe(404);
    const back = await upload(api, 7002, "harpoon-back.jpg");
    const acc2 = await api.json("POST", `/bulk/${back.body.photo_id}/accept`, { item_id: harpoon });
    expect(acc2.body.photos.map((p: any) => p.side)).toEqual(["front", "back"]);
  });

  it("handles no match: add as new, skip, delete", async () => {
    const api = makeClient();
    const a = (await upload(api, 7101, "IMG_0001.jpg")).body.photo_id;
    const b = (await upload(api, 7102, "IMG_0002.jpg")).body.photo_id;
    const m = await api.json("POST", `/admin/bulk/photos/${a}/match`);
    expect(m.body).toMatchObject({ status: "suggested", item: null });
    await api.json("POST", `/admin/bulk/photos/${b}/match`);

    // Skipping sends a photo to the back of the queue.
    await api.json("POST", `/bulk/${a}/skip`);
    const ids = (await api.json("GET", "/bulk?limit=500")).body.items.map((x: any) => x.photo_id);
    expect(ids.indexOf(a)).toBeGreaterThan(ids.indexOf(b));

    const created = await api.json("POST", `/bulk/${a}/new`, { description: "Brand new one (red)", size: "Tall Can" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ description: "Brand new one (red)", size: "Tall Can", origin: "scan" });
    expect(created.body.photos).toHaveLength(1);

    expect((await api.json("DELETE", `/bulk/${b}`)).status).toBe(200);
    expect((await api.call("GET", `/photos/${b}/full`)).status).toBe(404);
  });

  it("keeps a front/back pair together: matched, saved and discarded as one koozie", async () => {
    const api = makeClient();
    const id = await record(api, "bulk:pair", "Sprecher Root Beer pair test (brown)");
    const pair = async (seed: number, name: string) => {
      const fd = new FormData();
      fd.set("full", new Blob([fakeJpeg(800, 1000, seed)]));
      fd.set("thumb", new Blob([fakeJpeg(240, 300, seed, 256)]));
      fd.set("name", name);
      fd.set("back_full", new Blob([fakeJpeg(800, 1000, seed + 1)]));
      fd.set("back_thumb", new Blob([fakeJpeg(240, 300, seed + 1, 256)]));
      fd.set("back_name", `${name}-back`);
      return (await api.json("POST", "/admin/bulk/photos", fd)).body.photo_id as string;
    };
    const front = await pair(7301, "sprecher-root-beer-pair.jpg");
    const m = (await api.json("POST", `/admin/bulk/photos/${front}/match`)).body;
    expect(m.item.id).toBe(id);
    expect(m.back_photo_id).toBeTruthy();
    const item = (await api.json("POST", `/bulk/${front}/accept`, { item_id: id })).body;
    expect(item.photos.map((p: any) => p.side)).toEqual(["front", "back"]);

    const other = await pair(7311, "nothing.jpg");
    const back = (await api.json("GET", "/bulk?status=pending&limit=500")).body.items.find((b: any) => b.photo_id === other).back_photo_id;
    expect((await api.json("DELETE", `/bulk/${other}`)).status).toBe(200);
    expect((await api.call("GET", `/photos/${back}/full`)).status).toBe(404);
  });

  it("keeps waiting photos past the 24h scan cleanup", async () => {
    const api = makeClient();
    const id = (await upload(api, 7201, "old.jpg")).body.photo_id;
    const db = (env as unknown as Env).DB;
    await db.prepare("UPDATE photos SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(id).run();
    await api.scan(7202); // a scan triggers cleanup of abandoned scans
    expect((await api.call("GET", `/photos/${id}/full`)).status).toBe(200);
  });
});
