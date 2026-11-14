// Deterministic offline stand-ins for local development and tests. Never used when AI_PROVIDER=gemini.
//
// The mock embedding is derived from the SHA-256 of the image bytes, so the *same file* always
// matches itself perfectly while different photos look unrelated. That is enough to exercise
// the scan → match → save flow without a network or an API key; it says nothing about real
// visual similarity (use `npm run eval` with a Gemini key for that).

import type { Suggestion } from "../../shared/types";
import { normalize } from "../vectors";
import type { Describer, Embedder, Matcher, MatchResult, RecordOption } from "./types";

function xorshift(seed: number) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 0xffffffff) * 2 - 1;
  };
}

export class MockEmbedder implements Embedder {
  readonly modelId: string;
  constructor(readonly dims: number) {
    this.modelId = `mock@${dims}`;
  }
  async embedImage(jpeg: Uint8Array): Promise<Float32Array> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", jpeg as Uint8Array<ArrayBuffer>));
    const rand = xorshift((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]);
    const v = new Float32Array(this.dims);
    for (let i = 0; i < v.length; i++) v[i] = rand();
    return normalize(v);
  }
}

export class MockDescriber implements Describer {
  readonly modelId = "mock-describer";
  async describe(jpeg: Uint8Array): Promise<Suggestion> {
    return {
      // Deliberately made of words that won't text-match real descriptions.
      description: `Mock suggestion, AI is off locally (${Math.round(jpeg.length / 1024)} KB upload)`,
      color: null,
      size: null,
      base: null,
      visible_text: null,
      model: this.modelId,
    };
  }
}

/**
 * Offline matcher: picks the record whose description shares the most words with the photo's
 * original file name (so "harpoon-ipa.jpg" finds the Harpoon IPA record), else no match.
 * Good enough to exercise the bulk-review flow locally without an API key.
 */
export class MockMatcher implements Matcher {
  readonly modelId = "mock-matcher";
  async match(_jpeg: Uint8Array, records: RecordOption[], { hint = "" }: { hint?: string } = {}): Promise<MatchResult> {
    const words = new Set(hint.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
    const scored = records
      .map((r) => ({ r, n: r.description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    const best = scored[0];
    return {
      itemId: best?.r.id ?? null,
      confidence: !best ? "low" : best.n >= 2 && (scored[1]?.n ?? 0) < best.n ? "high" : "medium",
      alternatives: scored.slice(1, 4).map((x) => x.r.id),
      reason: best ? "Mock: file name shares words with the description" : "Mock: nothing in the file name matched",
      suggestion: { description: "Mock suggestion, AI is off locally", color: null, size: null, base: null, visible_text: null, model: this.modelId },
    };
  }
}
