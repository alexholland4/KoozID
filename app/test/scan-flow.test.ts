// End-to-end API flow: scan → candidates → decide → save → count/search, using the mock AI
// provider and the exact (D1) vector backend.

import { describe, expect, it } from "vitest";
import { AiError } from "../src/worker/errors";
import { MockEmbedder } from "../src/worker/ai/mock";
import { emptyFields, makeClient } from "./helpers";

describe("scan to save", () => {
  it("catalogues a new koozie and finds it again when re-scanned", async () => {
    const api = makeClient();
    const before = (await api.json("GET", "/stats")).body;

    // 1. First scan of a new koozie: nothing similar yet.
    const s1 = await api.scan(101);
    expect(s1.status).toBe(201);
    expect(s1.body.scan_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(["ok", "empty"]).toContain(s1.body.search_status);
    expect(s1.body.candidates.every((c: any) => c.band !== "strong")).toBe(true);

    // 2. Description suggestion (mock) is optional and editable.
    const d1 = await api.json("POST", `/scans/${s1.body.scan_id}/describe`);
    expect(d1.status).toBe(200);
    expect(d1.body.suggestion.description).toMatch(/mock/i);

    // 3. Save as unique.
    const saved = await api.json("POST", "/items", {
      scan_id: s1.body.scan_id,
      ...emptyFields,
      description: "Lakeside Lions shield logo (green)",
      size: "Standard Can",
      acquired_from: "Gift from Mom",
      city: "Kohler",
      state: "Wisconsin",
      side: "front",
    });
    expect(saved.status).toBe(201);
    expect(saved.body.code).toMatch(/^K-\d{4}$/);
    expect(saved.body).toMatchObject({ size: "Standard Can", acquired_from: "Gift from Mom", city: "Kohler", origin: "scan" });
    expect(saved.body.photos).toHaveLength(1);
    expect(saved.body.photos[0].indexed).toBe(true);

    const after = (await api.json("GET", "/stats")).body;
    expect(after.total).toBe(before.total + 1);
    expect(after.recent[0].id).toBe(saved.body.id);

    // 4. Re-scanning the identical photo returns the item as a strong match and flags the exact file.
    const s2 = await api.scan(101);
    expect(s2.body.search_status).toBe("ok");
    expect(s2.body.candidates[0].item.id).toBe(saved.body.id);
    expect(s2.body.candidates[0].band).toBe("strong");
    expect(s2.body.exact_photo_item.id).toBe(saved.body.id);

    // 5. "Already owned" + keep the photo on the existing record: count must not change.
    const attached = await api.json("POST", `/items/${saved.body.id}/photos`, { scan_id: s2.body.scan_id, side: "back" });
    expect(attached.status).toBe(201);
    expect(attached.body.photos.map((p: any) => p.side)).toEqual(["front", "back"]);
    expect((await api.json("GET", "/stats")).body.total).toBe(after.total);

    // 6. Text search finds it by description, by source and by catalogue code.
    const byBrand = await api.json("GET", "/items?q=lakeside%20lions");
    expect(byBrand.body.items.map((i: any) => i.id)).toContain(saved.body.id);
    const bySource = await api.json("GET", "/items?q=gift%20mom%20kohler");
    expect(bySource.body.items.map((i: any) => i.id)).toContain(saved.body.id);
    const byCode = await api.json("GET", `/items?q=${saved.body.code}`);
    expect(byCode.body.items[0].id).toBe(saved.body.id);
  });

  it("saving the same scan twice is idempotent", async () => {
    const api = makeClient();
    const s = await api.scan(202);
    const body = { scan_id: s.body.scan_id, ...emptyFields, description: "Double tap" };
    const [a, b] = [await api.json("POST", "/items", body), await api.json("POST", "/items", body)];
    expect(a.body.id).toBe(b.body.id);
    const list = await api.json("GET", "/items?q=double%20tap");
    expect(list.body.total).toBe(1);
  });

  it("a scan used for one item cannot be attached to another", async () => {
    const api = makeClient();
    const s = await api.scan(303);
    const item = await api.json("POST", "/items", { scan_id: s.body.scan_id, ...emptyFields, description: "first" });
    const other = await api.json("POST", "/items", { scan_id: (await api.scan(304)).body.scan_id, ...emptyFields, description: "second" });
    const res = await api.json("POST", `/items/${other.body.id}/photos`, { scan_id: s.body.scan_id });
    expect(res.status).toBe(409);
    expect(item.body.id).not.toBe(other.body.id);
  });

  it("items saved for review are excluded from the unique count until confirmed", async () => {
    const api = makeClient();
    const before = (await api.json("GET", "/stats")).body;
    const s = await api.scan(404);
    const item = await api.json("POST", "/items", {
      scan_id: s.body.scan_id,
      ...emptyFields,
      description: "Unsure",
      status: "needs_review",
      review_note: "Possible duplicate of K-0001",
    });
    let st = (await api.json("GET", "/stats")).body;
    expect(st.total).toBe(before.total);
    expect(st.needs_review).toBe(before.needs_review + 1);

    // Confirming it as unique counts it and clears the note.
    const upd = await api.json("PATCH", `/items/${item.body.id}`, { status: "active" });
    expect(upd.body.review_note).toBeNull();
    st = (await api.json("GET", "/stats")).body;
    expect(st.total).toBe(before.total + 1);
    expect(st.needs_review).toBe(before.needs_review);
  });

  it("still lets the user catalogue when the embedding API fails, then reindexes later", async () => {
    let fail = true;
    const mock = new MockEmbedder(768);
    const flaky = {
      modelId: mock.modelId,
      dims: 768,
      embedImage: async (b: Uint8Array) => {
        if (fail) throw new AiError("Gemini 503", "failed");
        return mock.embedImage(b);
      },
    };
    const api = makeClient({ embedder: () => flaky });
    const s = await api.scan(505);
    expect(s.status).toBe(201);
    expect(s.body.search_status).toBe("failed");
    expect(s.body.candidates).toEqual([]);

    const item = await api.json("POST", "/items", { scan_id: s.body.scan_id, ...emptyFields, description: "Saved offline-ish" });
    expect(item.status).toBe(201);
    expect(item.body.photos[0].indexed).toBe(false);
    expect((await api.json("GET", "/stats")).body.pending_index).toBeGreaterThan(0);

    fail = false;
    let r: any;
    do {
      r = (await api.json("POST", "/admin/reindex", { limit: 10 })).body;
    } while (r.remaining > 0 && r.embedded + r.indexed > 0);
    expect(r.remaining).toBe(0);
    const again = await api.scan(505);
    expect(again.body.candidates[0].item.id).toBe(item.body.id);
  });

  it("returns no suggestion (not an error) when the description model fails", async () => {
    const api = makeClient({
      describer: () => ({
        modelId: "broken",
        describe: async () => {
          throw new AiError("model overloaded");
        },
      }),
    });
    const s = await api.scan(606);
    const d = await api.json("POST", `/scans/${s.body.scan_id}/describe`);
    expect(d.status).toBe(200);
    expect(d.body.suggestion).toBeNull();
    expect(d.body.error).toContain("overloaded");
  });

  it("reports 'unavailable' when no API key is configured", async () => {
    const api = makeClient({}, { AI_PROVIDER: "gemini", GEMINI_API_KEY: "" });
    const s = await api.scan(707);
    expect(s.status).toBe(201);
    expect(s.body.search_status).toBe("unavailable");
  });

  it("enforces the daily AI cap", async () => {
    const api = makeClient({}, { AI_DAILY_LIMIT: "0" });
    const s = await api.scan(808);
    expect(s.body.search_status).toBe("failed");
    expect(s.body.search_error).toMatch(/Daily AI limit/);
  });

  it("can skip similarity search (used when adding photos to an existing item)", async () => {
    const api = makeClient();
    const s = await api.scan(909, false);
    expect(s.body.search_status).toBe("skipped");
  });
});
