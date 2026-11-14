# KoozID architecture

Research date: 2026-10-31. Pricing and limits are in [COSTS.md](COSTS.md).

## Summary

One Cloudflare Worker serves a React PWA as static assets and a small JSON API under `/api`.
D1 holds the records, R2 holds the photos, and Vectorize holds image vectors. Gemini provides
image embeddings and description suggestions. Cloudflare Access sits in front of the whole
hostname, and the Worker also verifies the Access JWT itself.

```
 Phone (PWA, React)                       Cloudflare (one Worker, one hostname)
 ┌──────────────────────────┐   HTTPS     ┌──────────────────────────────────────────────┐
 │ camera / library input   │──────────▶  │ Cloudflare Access (email one-time PIN)       │
 │ resize + EXIF-orient +   │             │   │                                          │
 │ re-encode JPEG (canvas)  │             │   ├─ static assets (free, no Worker run)     │
 │ CSV/ZIP export, importer │             │   └─ /api/* ─▶ Worker (Hono)                 │
 └──────────────────────────┘             │        verify Access JWT (RS256) + allowlist │
                                          │        ├─ D1  items, photos, embeddings, usage│
                                          │        ├─ R2  photos/{id}/full.jpg, thumb.jpg │
                                          │        └─ Vectorize  photo vectors (derived)  │
                                          └────────────┬─────────────────────────────────┘
                                                       │ fetch (server-side key)
                                          Google Gemini API: gemini-embedding-2 (vectors)
                                                             gemini-3.1-flash-lite (description)
```

## Changes from the original proposal

| Proposal | Decision | Why |
|---|---|---|
| Cloudflare Workers + D1 + R2 + Vectorize | **Kept** | Everything this app needs costs $0 at small scale, and egress is free. One account and one deploy command cover it all. The alternatives each had a dealbreaker: Supabase Free pauses idle projects and caps storage at 1 GB, Firebase needs the Blaze billing plan for Functions and Storage, and Cloud Run needs a billing account. |
| Vectorize "maybe unnecessary" | **Kept, behind an interface, with an exact D1 fallback** | Workers Free allows only **10 ms CPU per request**. Brute-force cosine over thousands of 768-d vectors in the Worker would exceed that. Vectorize does the search outside the Worker's CPU budget and is free up to 5M stored dimensions. `VECTOR_BACKEND=d1-exact` does exact search over embeddings stored in D1; it's used for local dev, tests, and small collections. |
| Gemini Embedding 2 | **Kept, but not yet validated on real calls** (see below) | It's the only current Gemini embedding model that accepts images. Workers AI has no image-embedding model (only text embedders). It supports image-to-image similarity because images and text share one vector space. It's $0.00012 per image on the paid tier and free on the free tier. |
| Flash-Lite for descriptions | **Kept as a separate, optional call** | The embedding API returns only a vector, so it can't produce text. Descriptions therefore need a generative call. That call runs in the background while the user reviews matches, so it adds no wait time. If it fails, the form simply starts empty. |
| Custom domain | **Moved to a Cloudflare zone** | Workers custom domains and Access both need the zone on Cloudflare. |
| Cloudflare Access | **Kept** | It's free for up to 50 users, uses email one-time PINs, and needs no passwords or code of ours. It protects the static app too. The Worker re-verifies the JWT (signature, `aud`, `iss`, `exp`) plus an optional email allowlist, so a misconfigured policy or a stray route can't expose the API. |

## Validation status of the image search

- **Built and tested:** ingestion, storage, the embedding call, ranking, and grouping photos into items.
  This runs end to end with a deterministic mock embedder (46 automated tests, plus a browser walkthrough).
- **Not yet validated:** retrieval quality with Gemini. No API key was available during the build.
  `npm run eval` measures it on a labelled synthetic set. That set covers re-shoots, back sides,
  colourways, same-brand redesigns, look-alikes, and novel designs. The command also suggests
  thresholds. The offline pixel baseline gets 50% recall@1 and 88% recall@5, so the set is hard
  enough to tell models apart ([EVALUATION.md](EVALUATION.md)). If Gemini underperforms, the
  `Embedder` interface (`src/worker/ai/types.ts`) is the only thing to swap. Candidates would be
  Vertex multimodal embeddings or a CLIP/SigLIP endpoint.

## Key design decisions

**Search**
- Each photo is embedded once at save time, and its vector is stored both in D1 (authoritative and
  regenerable) and in Vectorize (derived). A scan costs one embedding call plus one vector query.
  The collection is never sent to a model.
- Each photo is indexed separately, so the front and back of a koozie are separate vectors. Hits are
  collapsed to items by best photo (`search/rank.ts`), so a scan of the back finds the item.
- 768 dimensions by default (Matryoshka truncation). The eval reports recall at 3072, 1536, 768,
  512, and 256 dims, so the dimension can be lowered if quality holds. 512 fits ~9.7k photos in
  Vectorize Free and 256 fits ~19.5k. The dimension is fixed per index; changing it means a new
  index, then running "Rebuild search index".
- **Honest uncertainty.** The UI shows bands ("Very similar", "Somewhat similar", "Loose match"),
  never percentages. Thresholds come from config (`MATCH_STRONG` / `MATCH_POSSIBLE`) and are
  provisional until calibrated by `npm run eval`. The app never auto-rejects: the user decides.
- **Hybrid signal, kept cheap.** The description call also returns the koozie's printed text. The
  app runs a `LIKE` search for distinctive words from it and shows "Same printed text" matches that
  the visual search missed. That costs no extra AI calls.
- A **byte-identical photo** check (SHA-256) catches re-uploads of the same file, which is mainly
  useful during imports.
- **Second-stage LLM comparison: not built.** It would add a sequential multimodal call with 4–6
  images on every scan. Build it only if the eval with real photos shows the first stage confusing
  colourways or redesigns. It could then be an on-demand "Ask AI to compare" button.

**Data integrity**
- `items.id` is an `AUTOINCREMENT` catalogue number (K-0001, the spreadsheet's format) that is never
  reused. An import may set it explicitly to keep the spreadsheet's numbers; if that number is taken,
  the row gets the next free one and keeps its original ID in `external_ref`. The count is
  `COUNT(*)` of live items with `status='active'`. Items saved as "Not sure – save for review"
  (`needs_review`) aren't counted until confirmed.
- Save is atomic: a guarded `INSERT … WHERE EXISTS(unclaimed photo)` and the photo claim run in one
  D1 batch (a transaction). That makes double-taps idempotent and stops one scan becoming two items.
- Deletes are soft ("Recently deleted", restorable). Permanent purge is a separate explicit action.
  Search results always pass back through D1, so a stale vector can never surface a deleted item.
- Imports are idempotent on `external_ref`, so re-running an interrupted import is safe. Photos are
  stored before the item is created, which means a failure leaves only orphan files. Those are
  purged after 24 h with the abandoned scans.
- Unmapped spreadsheet columns are stored verbatim in `extra_json`, so nothing from the source
  spreadsheet is lost. Two exceptions: columns with a blank header, and summary tallies beside the
  data ("Total Koozies", "World Record", "Remaining"). Rows that hold nothing but a pre-filled ID are
  skipped (the real sheet is pre-numbered to K-4000).
- Item fields mirror the collector's spreadsheet (Source, Date Acquired, Size, Base, City, State,
  Country). Earlier attributes (brand, colours, theme, material) were dropped: the collector writes
  those into the description, and fewer fields means a faster form.
- Embeddings record their model (`gemini-embedding-2@768`). Changing provider or dimension
  re-embeds without touching any record.
- No FTS5: D1's `export` doesn't support virtual tables, and reliable backups matter more. Search
  uses `LIKE` over a trigger-maintained `search_text` column, which is fine at tens of thousands of rows.

**Images**
- The client decodes the photo (browsers apply EXIF orientation), downscales the long edge to
  1600 px at JPEG q0.86 (~200–450 KB) plus a 480 px thumbnail, and re-encodes. Re-encoding strips
  EXIF data, including GPS. Camera originals aren't kept: 1600 px is plenty for logos and fine
  print, and storing originals would be about 10× the storage.
- The server accepts only real JPEGs (magic bytes + SOF parse), within size and dimension limits.
- Photos are private. They're served only through `/api/photos/:id/(thumb|full)` behind auth, with
  `Cache-Control: private, immutable`, and are never exposed from a public bucket.

**Security**
- Auth: Access JWT verified with WebCrypto against the team's JWKS, which is cached and refetched on
  key rotation. Missing config fails closed. `AUTH_MODE=dev` is honoured only on localhost.
- Mutations require an `x-koozid: 1` header (CSRF), and there's no CORS.
- Admin tools (import, reindex, demo purge) can be limited with `ADMIN_EMAILS`.
- Cost guard: per-day counters in D1 cap interactive AI calls (`AI_DAILY_LIMIT`) and bulk calls
  (`AI_DAILY_REINDEX_LIMIT`).
- Model output is treated as untrusted. It's parsed against a JSON schema, then trimmed and
  length-capped. CSV export neutralises formula injection.

**UX**
- Picking a photo immediately uploads and searches, and Retake is always one tap. The description
  runs while the user compares. "Scan Next" opens the camera directly.
- Candidate cards are large. The compare sheet shows the two photos side by side (or stacked
  larger) and can browse all of a candidate's photos.
- "Already Owned" asks which item it is and can optionally attach the photo to that record, for
  example as its back side.
- There's no service worker, on purpose. An offline cache adds little to a camera-to-server flow
  and can interfere with Access sessions. The app is still installable (manifest + icons).

**Contributions**
- Visitors offer a koozie with name, email and an optional count (`POST /pub/offers`: CSRF header,
  a hidden honeypot field, a per-day cap, and repeat offers from one email merge into one request).
  The collector approves offers in the app. Only then is his mailing address emailed. The address is
  an admin-only setting that no `/pub` route returns. Gifts from the Amazon wish list skip approval.
- Once the koozie is cataloged, he picks its number(s) and the visitor gets a thank-you with each
  koozie's photo and public link. Emails go through `src/worker/mail.ts`. It's off until a provider is
  connected ([DEPLOYMENT.md §8](DEPLOYMENT.md#8-email-koozie-offers-and-thank-yous)); until then
  every email comes back as a draft the collector sends from his own mail app.
- Leaderboard groups (`source_groups`) map exact sources to one contributor name. Items keep their
  precise source. The leaderboard, standing badges and `?source=` filters resolve through the group.

## Code map

```
src/shared/      types, limits, CSV, import planning (pure, tested)
src/worker/      app.ts (routes) · catalog.ts (application logic) · db.ts (SQL) · auth.ts
                 images.ts (validation/R2) · ai/ (gemini, mock) · search/ (vectorize, exact, rank)
src/client/      pages/ (Home, Scan, Collection, Item, More, Import) · components/ · image.ts · exporter.ts
migrations/      D1 schema
test/            Workers-runtime tests (vitest + @cloudflare/vitest-plugin)
scripts/         fixtures generator, seed-demo, eval
fixtures/        synthetic koozie photos + labels; import-sample/ for trying the importer
```

## Known limitations

- **Gemini retrieval quality and thresholds are unverified** until `npm run eval` runs with a key.
  The synthetic fixtures are a proxy, so calibrate again on real photos once the collection arrives.
- Visual similarity isn't duplicate status. Same-artwork colourways and redesigns can score high,
  and photos of different sides can score low unless both sides are indexed.
- No bulk "find duplicates already in the imported spreadsheet" audit yet. The data model supports
  it (query each photo against the index in batches); it's a reasonable next feature.
- The ZIP backup is built in the browser, so it's practical in batches of about 1,000 items. Full
  disaster recovery uses `wrangler d1 export` + rclone ([MAINTENANCE.md](MAINTENANCE.md)).
- XLSX isn't read directly. Save as CSV UTF-8 first.
- Workers Free's 10 ms CPU limit hasn't been measured under production load. The hot paths are
  native operations (multipart, base64, JSON, WebCrypto), but if requests hit CPU-limit errors,
  Workers Paid ($5/mo) removes the limit.
- KoozID suggests possible duplicates. It doesn't verify uniqueness or apply Guinness World Records
  criteria.
