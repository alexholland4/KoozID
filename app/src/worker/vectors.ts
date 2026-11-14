// Small vector helpers. Embeddings are stored in D1 as float32 little-endian BLOBs.

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Dot product; equals cosine similarity for unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function fromBlob(blob: ArrayBuffer | Uint8Array | number[]): Float32Array {
  const bytes = blob instanceof Uint8Array ? blob : blob instanceof ArrayBuffer ? new Uint8Array(blob) : Uint8Array.from(blob);
  const copy = bytes.slice(); // ensure 4-byte alignment
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
