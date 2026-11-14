// Vector search over photo embeddings.
//
// Two interchangeable backends:
//   - "vectorize": Cloudflare Vectorize (ANN index, no Worker CPU spent on similarity). Production.
//   - "d1-exact":  brute-force cosine over embeddings stored in D1. Local dev, tests, and a
//                  fallback for small collections (CPU grows linearly with photo count).
// D1 always keeps a copy of every embedding, so the Vectorize index can be rebuilt at any time
// without calling the embedding API again.

import type { Config, Env } from "../env";
import { dot, fromBlob } from "../vectors";

export interface PhotoHit {
  photoId: string;
  score: number;
}

export interface VectorIndex {
  readonly name: string;
  upsert(entries: { photoId: string; itemId: number; vector: Float32Array }[]): Promise<void>;
  remove(photoIds: string[]): Promise<void>;
  query(vector: Float32Array, topK: number): Promise<PhotoHit[]>;
}

export class VectorizeIndexBackend implements VectorIndex {
  readonly name = "vectorize";
  constructor(private index: VectorizeIndex) {}

  async upsert(entries: { photoId: string; itemId: number; vector: Float32Array }[]) {
    for (let i = 0; i < entries.length; i += 500) {
      await this.index.upsert(
        entries.slice(i, i + 500).map((e) => ({ id: e.photoId, values: Array.from(e.vector), metadata: { item: e.itemId } })),
      );
    }
  }

  async remove(photoIds: string[]) {
    for (let i = 0; i < photoIds.length; i += 500) await this.index.deleteByIds(photoIds.slice(i, i + 500));
  }

  async query(vector: Float32Array, topK: number): Promise<PhotoHit[]> {
    const res = await this.index.query(Array.from(vector), { topK, returnValues: false, returnMetadata: "none" });
    return res.matches.map((m) => ({ photoId: m.id, score: m.score }));
  }
}

export class D1ExactIndex implements VectorIndex {
  readonly name = "d1-exact";
  constructor(
    private db: D1Database,
    private modelId: string,
  ) {}

  // D1 already holds the embeddings and the `indexed` flag; nothing else to maintain.
  async upsert() {}
  async remove() {}

  async query(vector: Float32Array, topK: number): Promise<PhotoHit[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.id, p.embedding FROM photos p JOIN items i ON i.id = p.item_id
         WHERE p.indexed = 1 AND p.embedding_model = ? AND i.deleted_at IS NULL`,
      )
      .bind(this.modelId)
      .all<{ id: string; embedding: ArrayBuffer | Uint8Array | number[] }>();
    const hits = results.map((r) => ({ photoId: r.id, score: dot(vector, fromBlob(r.embedding)) }));
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }
}

export function createIndex(env: Env, cfg: Config, embeddingModelId: string): VectorIndex {
  if (cfg.vectorBackend === "vectorize") {
    if (!env.VECTORS) throw new Error("VECTOR_BACKEND=vectorize but the VECTORS binding is missing");
    return new VectorizeIndexBackend(env.VECTORS);
  }
  return new D1ExactIndex(env.DB, embeddingModelId);
}
