import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createApp, type AppOptions } from "../src/worker/app";
import type { Env } from "../src/worker/env";

/**
 * A structurally valid JPEG header (SOI + APP0 + SOF0 + EOI) with `seed`-dependent padding,
 * so different seeds produce different bytes (and different mock embeddings).
 */
export function fakeJpeg(width = 800, height = 1000, seed = 1, padding = 2048): Uint8Array<ArrayBuffer> {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const com = [0xff, 0xfe, ((padding + 2) >> 8) & 255, (padding + 2) & 255];
  const body = new Uint8Array(padding);
  let x = seed * 2654435761;
  for (let i = 0; i < padding; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    body[i] = x & 0xff;
  }
  return new Uint8Array([0xff, 0xd8, ...app0, ...com, ...body, ...sof, 0xff, 0xd9]);
}

export function jpegFile(seed: number, name = `photo-${seed}.jpg`) {
  return new File([fakeJpeg(800, 1000, seed)], name, { type: "image/jpeg" });
}

export function makeClient(opts: AppOptions = {}, extraEnv: Partial<Env> = {}, host = "http://localhost") {
  const app = createApp(opts);
  const testEnv = { ...(env as unknown as Env), ...extraEnv };
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: { ...headers } };
    if (method !== "GET") (init.headers as Record<string, string>)["x-koozid"] ??= "1";
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${host}/api${path}`, init), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  return {
    call,
    async json<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }> {
      const res = await call(method, path, body, headers);
      return { status: res.status, body: (await res.json()) as T };
    },
    async scan(seed: number, search = true) {
      const fd = new FormData();
      fd.set("full", jpegFile(seed));
      fd.set("thumb", new File([fakeJpeg(240, 300, seed, 256)], "t.jpg", { type: "image/jpeg" }));
      if (!search) fd.set("search", "0");
      const res = await call("POST", "/scans", fd);
      return { status: res.status, body: (await res.json()) as any };
    },
  };
}

export const emptyFields = {
  description: "",
  size: null,
  base: null,
  acquired_from: null,
  city: null,
  state: null,
  country: null,
  visible_text: null,
  notes: null,
};
