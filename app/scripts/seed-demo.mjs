#!/usr/bin/env node
// Load the synthetic fixture catalogue (fixtures/manifest.json) into a running KoozID as DEMO data.
// Demo items are flagged and can be removed in one step (Tools → Remove demo data).
//
//   npm run seed:demo                                  # local dev server on :5173
//   node scripts/seed-demo.mjs --url https://koozid.example.com
//
// For a deployment behind Cloudflare Access, create a service token, allow its client id in
// SERVICE_TOKEN_CLIENT_IDS, and export CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argUrl = process.argv.indexOf("--url");
const base = (argUrl > 0 ? process.argv[argUrl + 1] : "http://localhost:5173").replace(/\/$/, "");
const headers = { "x-koozid": "1" };
if (process.env.CF_ACCESS_CLIENT_ID) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
}

async function call(method, p, body) {
  const res = await fetch(`${base}/api${p}`, {
    method,
    headers: body instanceof FormData ? headers : { ...headers, "content-type": "application/json" },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`Redirected to login (${res.status}); check the Access service token`);
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const manifest = JSON.parse(await readFile(path.join(root, "fixtures", "manifest.json"), "utf8"));
let created = 0;
for (const c of manifest.catalog) {
  const fd = new FormData();
  fd.set(
    "meta",
    JSON.stringify({
      external_ref: `demo:${c.key}`,
      description: `${c.brand} ${c.tagline} print (${c.primary_color})`,
      visible_text: `${c.brand.toUpperCase()} / ${c.tagline}`,
      size: "Standard Can",
      base: "Collapsible",
      acquired_from: "Demo data",
      demo: true,
    }),
  );
  for (const [i, f] of c.photos.entries()) {
    const bytes = await readFile(path.join(root, "fixtures", "images", f));
    // Fixtures are already modest JPEGs; the same file serves as the thumbnail.
    fd.set(`full_${i}`, new Blob([bytes], { type: "image/jpeg" }), f);
    fd.set(`thumb_${i}`, new Blob([bytes], { type: "image/jpeg" }), f);
    fd.set(`name_${i}`, f);
    fd.set(`side_${i}`, f.includes("-back") ? "back" : "front");
  }
  const r = await call("POST", "/admin/import", fd);
  if (r.status === "created") created++;
  process.stdout.write(`\r${c.key.padEnd(24)} ${r.status}   `);
}
console.log(`\nImported ${created} new demo item(s). Indexing photos…`);

for (;;) {
  const r = await call("POST", "/admin/reindex", { limit: 10 });
  process.stdout.write(`\rindexed ${r.indexed}, remaining ${r.remaining}   `);
  if (r.stopped_reason) {
    console.log(`\nPaused: ${r.stopped_reason}`);
    break;
  }
  if (r.remaining === 0 || r.embedded + r.indexed === 0) break;
}
console.log("\nDone. Query photos for testing scans are in fixtures/images/q-*.jpg");
