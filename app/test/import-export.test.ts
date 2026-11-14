import { describe, expect, it } from "vitest";
import { parseCsv, parseLooseDate, toCsv } from "../src/shared/csv";
import { buildPlan, findGoal, guessMapping, photosOnlyPlan, sideFromName } from "../src/shared/importer";
import { fakeJpeg, makeClient } from "./helpers";

describe("csv", () => {
  it("parses quotes, embedded newlines, CRLF, BOM and semicolons", () => {
    const text = '﻿ID,Description,Notes\r\n1,"Green, foam","said ""hi""\nline2"\r\n2,Plain,\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["ID", "Description", "Notes"],
      ["1", "Green, foam", 'said "hi"\nline2'],
      ["2", "Plain", ""],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("round-trips and neutralises formula injection", () => {
    const csv = toCsv([
      ["a", "b"],
      ['x "y"', "=HYPERLINK(1)"],
    ]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ['x "y"', "'=HYPERLINK(1)"],
    ]);
  });

  it("parses loose dates", () => {
    expect(parseLooseDate("2021-03-04")).toBe("2021-03-04");
    expect(parseLooseDate("3/4/2021")).toBe("2021-03-04");
    expect(parseLooseDate("3/4/21")).toBe("2021-03-04");
    expect(parseLooseDate("2/30/2021")).toBeNull();
    expect(parseLooseDate("last summer")).toBeNull();
  });
});

describe("import planning", () => {
  const headers = ["Koozie #", "Description", "Date Added", "Where from", "Shelf"];
  const rows = [
    ["101", "Green Lions koozie", "6/1/2019", "Garage sale", "A1"],
    ["102", "Blue Polar Pub", "sometime", "", "A2"],
    ["103", "No photo one", "", "", ""],
    ["101", "Dup id", "", "", ""],
  ];
  const files = ["101.jpg", "101_back.JPG", "102-2.jpeg", "999.jpg", "1010.jpg"].map((name) => ({ file: name, name }));

  it("guesses a sensible mapping", () => {
    const m = guessMapping(headers);
    expect(m.external_ref).toBe(0);
    expect(m.description).toBe(1);
    expect(m.acquired_on).toBe(2);
    expect(m.acquired_from).toBe(3);
  });

  it("matches photos by ID, keeps unmapped columns, reports problems", () => {
    const plan = buildPlan(headers, rows, guessMapping(headers), files);
    const [r1, r2, r3] = plan.rows;
    expect(r1.files.map((f) => [f.name, f.side])).toEqual([
      ["101.jpg", "front"],
      ["101_back.JPG", "back"],
    ]);
    expect(r1.acquiredOn).toBe("2019-06-01");
    expect(r1.extra).toEqual({ Shelf: "A1" });
    expect(r1.fields.acquired_from).toBe("Garage sale");
    expect(r1.number).toBe(101);
    expect(r2.files.map((f) => f.name)).toEqual(["102-2.jpeg"]);
    expect(r2.warnings[0]).toMatch(/Unrecognised date/);
    expect(r2.extra["Date Added"]).toBe("sometime");
    expect(r3.files).toEqual([]);
    expect(plan.unusedFiles.sort()).toEqual(["1010.jpg", "999.jpg"]); // 1010 must not match 101
    expect(plan.duplicateRefs).toEqual(["101"]);
  });

  it("reads the collector's spreadsheet layout", () => {
    // Same shape as the real tracker: pre-numbered blank rows, a misspelt header, and summary
    // tallies in columns beside the data (only filled on the first row).
    const h = ["Koozie ID", "Date Acquired", "Source", "Desciption", "Size", "Base", "City", "State", "Country", "Photo", "", "Total Koozies", "World Record", "Remaining"];
    const rows = [
      ["K-0001", "11/10/2025", "Purchased on Amazon", "NCAA UW Badgers", "Standard Can", "Collapsible", "South Boston", "Massachusetts", "United States of America", "", "", "3", "3715", "3712"],
      ["K-0002", "1/10/2026", "Purchased at a bar, VT", "Bar logo (black)", "Tall Can", "Structured", "West Dover", "Vermont", "United States of America", "", "", "", "", ""],
      ["K-0003", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["K-0004", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ];
    const m = guessMapping(h);
    expect(m).toEqual({ external_ref: 0, acquired_on: 1, acquired_from: 2, description: 3, size: 4, base: 5, city: 6, state: 7, country: 8, photos: 9 });
    const plan = buildPlan(h, rows, m, []);
    expect(plan.rows).toHaveLength(2);
    expect(plan.blankRows).toBe(2);
    expect(plan.ignored).toEqual(["Column 11", "Total Koozies", "World Record", "Remaining"]);
    expect(plan.rows[0]).toMatchObject({
      externalRef: "K-0001",
      number: 1,
      acquiredOn: "2025-11-10",
      extra: {},
      warnings: [],
      fields: { description: "NCAA UW Badgers", size: "Standard Can", base: "Collapsible", acquired_from: "Purchased on Amazon", city: "South Boston", state: "Massachusetts" },
    });
    expect(findGoal(h, rows)).toEqual({ column: "World Record", value: 3715 });
    expect(findGoal(["ID", "Description"], [["1", "x"]])).toBeNull();
  });

  it("uses an explicit photo column when mapped and reports missing files", () => {
    const plan = buildPlan(["Name", "Pictures"], [["A", "IMG_1.jpg; img_2"], ["B", "nope.jpg"]], { description: 0, photos: 1 }, [
      { file: 1, name: "img_1.JPG" },
      { file: 2, name: "IMG_2.png" },
    ]);
    expect(plan.rows[0].files).toHaveLength(2);
    expect(plan.rows[1].missing).toEqual(["nope.jpg"]);
  });

  it("groups photo-only imports by name", () => {
    const plan = photosOnlyPlan(["k1_front.jpg", "k1_back.jpg", "k2.jpg"].map((name) => ({ file: name, name })));
    expect(plan.rows.map((r) => [r.externalRef, r.files.length])).toEqual([
      ["k1", 2],
      ["k2", 1],
    ]);
    expect(sideFromName("k1_back.jpg")).toBe("back");
    expect(sideFromName("club.jpg")).toBe("front");
  });
});

describe("import + export API", () => {
  const importOne = async (api: ReturnType<typeof makeClient>, meta: object, photos = 1) => {
    const fd = new FormData();
    fd.set("meta", JSON.stringify(meta));
    for (let i = 0; i < photos; i++) {
      fd.set(`full_${i}`, new Blob([fakeJpeg(800, 1000, 9000 + i + JSON.stringify(meta).length)]));
      fd.set(`thumb_${i}`, new Blob([fakeJpeg(200, 250, 1, 64)]));
      fd.set(`side_${i}`, i === 0 ? "front" : "back");
    }
    return api.json("POST", "/admin/import", fd);
  };

  it("imports idempotently, preserves extra columns, then indexes and exports", async () => {
    const api = makeClient();
    const meta = { external_ref: "sheet#7", description: "Imported Hogs & Heat", acquired_on: "2019-06-01", extra: { Shelf: "B4" }, demo: true };
    const a = await importOne(api, meta, 2);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ status: "created", photos: 2 });
    const b = await importOne(api, meta, 2);
    expect(b.body).toMatchObject({ status: "exists", id: a.body.id });

    const item = (await api.json("GET", `/items/${a.body.id}`)).body;
    expect(item).toMatchObject({ origin: "import", external_ref: "sheet#7", acquired_on: "2019-06-01", extra: { Shelf: "B4" }, is_demo: true });
    expect(item.photos.map((p: any) => p.side)).toEqual(["front", "back"]);
    expect(item.photos.every((p: any) => !p.indexed)).toBe(true);
    expect((await api.json("GET", "/items?q=b4")).body.items.map((i: any) => i.id)).toContain(a.body.id); // extra columns searchable

    let r: any;
    do r = (await api.json("POST", "/admin/reindex", { limit: 5 })).body;
    while (r.remaining > 0 && r.embedded + r.indexed > 0);
    expect(r.remaining).toBe(0);

    // Export pages include the full record and photo metadata.
    let all: any[] = [];
    let off: number | null = 0;
    while (off !== null) {
      const page: any = (await api.json("GET", `/export/items?offset=${off}&limit=3`)).body;
      all = all.concat(page.items);
      off = page.next_offset;
    }
    const exported = all.find((i) => i.id === a.body.id);
    expect(exported.photos).toHaveLength(2);
    expect(exported.extra).toEqual({ Shelf: "B4" });
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);

    // Demo purge removes it completely.
    const purge = (await api.json("POST", "/admin/demo/purge")).body;
    expect(purge.remaining).toBe(0);
    expect((await api.json("GET", `/items/${a.body.id}`)).status).toBe(404);
  });

  it("keeps the spreadsheet's catalogue numbers, and new koozies continue after them", async () => {
    const api = makeClient();
    const a = await importOne(api, { external_ref: "K-0900", number: 900, description: "Numbered", size: "Tall Can", city: "Boston", state: "Massachusetts" }, 0);
    expect(a.body).toMatchObject({ status: "created", id: 900 });
    const item = (await api.json("GET", "/items/900")).body;
    expect(item).toMatchObject({ code: "K-0900", size: "Tall Can", city: "Boston", photos: [] });

    // Number already taken: the row still imports, under a new number.
    const b = await importOne(api, { external_ref: "other-sheet:K-0900", number: 900, description: "Clash" }, 0);
    expect(b.body.status).toBe("created");
    expect(b.body.id).not.toBe(900);
    expect(b.body.id).toBeGreaterThan(900);

    // Photo-less records are counted, listed under "no photo" and reported to the scan screen.
    const st = (await api.json("GET", "/stats")).body;
    expect(st.no_photo).toBeGreaterThanOrEqual(2);
    const bare = (await api.json("GET", "/items?photo=none&limit=200")).body.items.map((i: any) => i.id);
    expect(bare).toEqual(expect.arrayContaining([900, b.body.id]));
    const scan = await api.scan(9090);
    expect(scan.body.unphotographed).toBe(st.no_photo);

    // Values already used are offered for autocomplete.
    const values = (await api.json("GET", "/values")).body;
    expect(values.city).toContain("Boston");
    expect(values.state).toContain("Massachusetts");
  });

  it("stores the collection goal", async () => {
    const api = makeClient();
    expect((await api.json("PUT", "/admin/settings", { goal: 3715 })).body).toEqual({ goal: 3715 });
    expect((await api.json("GET", "/stats")).body.goal).toBe(3715);
    expect((await api.json("PUT", "/admin/settings", { goal: "lots" })).status).toBe(400);
    expect((await api.json("PUT", "/admin/settings", { goal: null })).body).toEqual({ goal: null });
    expect((await api.json("GET", "/stats")).body.goal).toBeNull();
  });

  it("rejects a bad import without leaving a half-created item", async () => {
    const api = makeClient();
    const before = (await api.json("GET", "/stats")).body.total;
    const fd = new FormData();
    fd.set("meta", JSON.stringify({ external_ref: "bad-1", description: "bad" }));
    fd.set("full_0", new Blob([fakeJpeg(800, 1000, 1)]));
    fd.set("thumb_0", new Blob([fakeJpeg(200, 250, 1, 64)]));
    fd.set("full_1", new Blob([new Uint8Array([1, 2, 3])])); // corrupt second photo
    fd.set("thumb_1", new Blob([fakeJpeg(200, 250, 1, 64)]));
    const r = await api.json("POST", "/admin/import", fd);
    expect(r.status).toBe(400);
    expect((await api.json("GET", "/stats")).body.total).toBe(before);
    expect((await api.json("GET", "/items?q=bad-1")).body.total).toBe(0);
    expect((await api.json("POST", "/admin/import", (() => { const f = new FormData(); f.set("meta", "{nope"); return f; })())).status).toBe(400);
  });
});
