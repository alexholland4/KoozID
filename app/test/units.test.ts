import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiDescriber, GeminiEmbedder, toBase64 } from "../src/worker/ai/gemini";
import { sanitizeSuggestion } from "../src/worker/ai/suggestion";
import { itemCode, parseItemCode } from "../src/shared/types";
import { textTerms } from "../src/worker/catalog";
import { AiError } from "../src/worker/errors";
import { jpegSize } from "../src/worker/images";
import { band, rankItems } from "../src/worker/search/rank";
import { dot, fromBlob, normalize, toBlob } from "../src/worker/vectors";
import { fakeJpeg } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("ranking", () => {
  it("collapses photo hits to items using each item's best photo", () => {
    const hits = [
      { photoId: "a-back", score: 0.95 },
      { photoId: "b-front", score: 0.9 },
      { photoId: "a-front", score: 0.7 },
      { photoId: "ghost", score: 0.99 }, // stale vector, no longer in D1
      { photoId: "c-front", score: 0.5 },
    ];
    const map = new Map([
      ["a-back", 1],
      ["a-front", 1],
      ["b-front", 2],
      ["c-front", 3],
    ]);
    const r = rankItems(hits, map, 2);
    expect(r).toEqual([
      { itemId: 1, score: 0.95, photoId: "a-back" },
      { itemId: 2, score: 0.9, photoId: "b-front" },
    ]);
  });

  it("bands scores by calibrated thresholds", () => {
    expect(band(0.95, 0.9, 0.8)).toBe("strong");
    expect(band(0.85, 0.9, 0.8)).toBe("possible");
    expect(band(0.5, 0.9, 0.8)).toBe("weak");
  });
});

describe("vectors", () => {
  it("round-trips float32 blobs including D1's number[] form", () => {
    const v = normalize(Float32Array.from([3, 4, 0]));
    expect(dot(v, v)).toBeCloseTo(1);
    const blob = toBlob(v);
    expect(Array.from(fromBlob(blob))).toEqual(Array.from(v));
    expect(Array.from(fromBlob(Array.from(blob)))).toEqual(Array.from(v));
    expect(Array.from(fromBlob(blob.buffer as ArrayBuffer))).toEqual(Array.from(v));
  });
});

describe("jpeg parsing", () => {
  it("reads dimensions and rejects other formats", () => {
    expect(jpegSize(fakeJpeg(1234, 567))).toEqual({ width: 1234, height: 567 });
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
    expect(jpegSize(new Uint8Array([]))).toBeNull();
  });
});

describe("gemini provider", () => {
  const jpeg = fakeJpeg(100, 100, 1, 64);

  it("sends inline JPEG with the requested dimensionality and normalises the result", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ embedding: { values: [3, 4, 0, 0] } }));
    const e = new GeminiEmbedder("k", "gemini-embedding-2", 4);
    const v = await e.embedImage(jpeg);
    expect(Array.from(v).map((x) => +x.toFixed(3))).toEqual([0.6, 0.8, 0, 0]);
    expect(e.modelId).toBe("gemini-embedding-2@4");
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/models/gemini-embedding-2:embedContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(init.body as string);
    expect(body.outputDimensionality).toBe(4);
    expect(body.content.parts[0].inlineData).toEqual({ mimeType: "image/jpeg", data: toBase64(jpeg) });
  });

  it("maps HTTP errors and malformed responses to AiError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("quota", { status: 429 }));
    const e = new GeminiEmbedder("k", "m", 4);
    await expect(e.embedImage(jpeg)).rejects.toMatchObject({ kind: "rate_limited" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ embedding: { values: [1, 2] } }));
    await expect(e.embedImage(jpeg)).rejects.toBeInstanceOf(AiError);
    await expect(new GeminiEmbedder("", "m", 4).embedImage(jpeg)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("parses structured description output and ignores thought parts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        candidates: [
          {
            content: {
              parts: [
                { text: "thinking...", thought: true },
                { text: JSON.stringify({ description: "Lakeside Lions logo (green)", size: "tall can", base: "Foam", visible_text: "" }) },
              ],
            },
          },
        ],
      }),
    );
    const s = await new GeminiDescriber("k", ["gemini-3.1-flash-lite"]).describe(jpeg);
    // Size is normalised to the spreadsheet's spelling; an unknown base is dropped.
    expect(s).toMatchObject({ description: "Lakeside Lions logo (green)", size: "Tall Can", base: null, visible_text: null });
  });

  it("rejects non-JSON description output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "Sure! Here is" }] } }] }));
    await expect(new GeminiDescriber("k", ["m"]).describe(jpeg)).rejects.toBeInstanceOf(AiError);
  });

  it("falls back to the next model when one is overloaded, and sends the back photo too", async () => {
    const calls: { url: string; images: number }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      calls.push({ url: String(url), images: body.contents[0].parts.filter((p: any) => p.inlineData).length });
      if (String(url).includes("/busy:")) return new Response("high demand", { status: 503 });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ description: "Front text, back: website", color: "Navy Blue" }) }] } }] });
    });
    const s = await new GeminiDescriber("k", ["busy", "spare"]).describe(jpeg, jpeg);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["busy:generateContent", "spare:generateContent"]);
    expect(calls[1].images).toBe(2);
    expect(s).toMatchObject({ description: "Front text, back: website", color: "navy blue", model: "spare" });
  });

  it("doesn't fall back on a request error", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(new GeminiDescriber("k", ["a", "b"]).describe(jpeg)).rejects.toBeInstanceOf(AiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("suggestion sanitising", () => {
  it("trims, nulls placeholders, caps length and requires a description", () => {
    const s = sanitizeSuggestion({ description: "  x ", size: 5, base: "N/A", visible_text: "a".repeat(5000) }, "m");
    expect(s.description).toBe("x");
    expect(s.size).toBeNull();
    expect(s.base).toBeNull();
    expect(s.visible_text!.length).toBe(2000);
    expect(() => sanitizeSuggestion({ description: "" }, "m")).toThrow(AiError);
    expect(() => sanitizeSuggestion("nope", "m")).toThrow(AiError);
  });

  it("extracts distinctive text terms for the text cross-check", () => {
    expect(textTerms({ description: "ignored when text was read", visible_text: "HOPPY TRAILS / Brewing Co. / Drink Local" })).toEqual([
      "brewing",
      "trails",
      "hoppy",
      "drink",
    ]);
    // Without printed text, the description's distinctive words are used; colours are not distinctive.
    expect(textTerms({ description: "Santa face, present, bell (green/blue)", visible_text: null })).toEqual(["present", "santa", "face", "bell"]);
    expect(textTerms({ description: "", visible_text: null })).toEqual([]);
  });

  it("formats and parses catalogue numbers like the spreadsheet", () => {
    expect(itemCode(1)).toBe("K-0001");
    expect(itemCode(12345)).toBe("K-12345");
    expect(parseItemCode("K-0042")).toBe(42);
    expect(parseItemCode("k42")).toBe(42);
    expect(parseItemCode("#7")).toBe(7);
    expect(parseItemCode("42")).toBe(42);
    expect(parseItemCode("sheet#7")).toBeNull();
    expect(parseItemCode("K-0000")).toBeNull();
  });
});
