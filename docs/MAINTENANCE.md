# Maintenance

Run the commands below from the `app/` folder.

## Importing the existing collection

1. In Excel, save the spreadsheet as **CSV UTF-8** (File → Save As).
2. Put the photos in one folder. The importer matches them to rows in one of two ways:
   - **By a photo column:** a column that lists file names, separated by `;`, `,`, or `|`.
   - **By ID:** `123.jpg`, `123_back.jpg`, `123-2.jpg`, and `123 front.jpg` all match a row with ID
     `123`. A name containing `back` is stored as the back side.
3. In the app, go to **Tools → Import spreadsheet & photos**. Choose the CSV, check the column
   mapping, and select the photos (or the whole folder).
4. Review the report before importing. It lists:
   - rows without photos
   - photos named in the sheet but not found
   - photos that didn't match any row
   - duplicate IDs
   - unparseable dates
5. **Import**. It runs two rows at a time and can be paused and resumed. Re-running skips rows
   already imported (keyed by the ID column, or by `file#row` when there's no ID column).
6. **Update search index**. This generates an embedding per photo in small batches. If it pauses
   on the daily cap or Gemini free-tier rate limits, run it again later from Tools.

Imported items count as unique; the spreadsheet is treated as already curated. Unmapped columns
are kept, shown under "From the original spreadsheet", and are searchable.
`fixtures/import-sample/` has a 4-row example to practise with. Mark it as demo data so it can be
removed afterwards.

**Big imports.** Photos are resized in the browser, so use a laptop. 10,000 photos takes roughly
1–2 hours of uploading at typical home upload speeds (estimate). Indexing is separate and resumable.

## Backups

| What | How | Frequency |
|---|---|---|
| Records (authoritative) | D1 **Time Travel** restores to any minute in the last 7 days (Free) / 30 days (Paid): `npx wrangler d1 time-travel restore koozid --timestamp=<ISO>` | automatic |
| Records snapshot | `npx wrangler d1 export koozid --remote --output=backups/koozid-$(date +%F).sql` | monthly, and before big changes |
| Photos | [rclone](https://rclone.org/s3/#cloudflare-r2) with an R2 API token: `rclone sync r2:koozid-photos ./backups/photos` | monthly |
| Human-readable copy | **Tools → Export spreadsheet (CSV)**, and **Full backup (ZIP)** in ID ranges of ~1,000 | whenever |

Embeddings live in D1 and are included in the SQL export. They can be regenerated anyway, so
losing them only costs re-indexing time.

To restore into a fresh database:
`npx wrangler d1 execute koozid --remote --file=backups/koozid-YYYY-MM-DD.sql`, then
`rclone sync` the photos back. After that, run **Rebuild search index**.

### Data-loss risks and planned safeguards

Decided 2026-11-02: implement these **before Bobby starts photographing the collection**.

What can't lose data: free-plan limits (they block writes, never delete), idle accounts (D1/R2 don't
expire), Gemini changes (only search breaks; re-run **Update search index**), the domain lapsing
(site offline, data intact), and code deploys (migrations are additive).

What can:

| Risk | Today's protection | Gap |
|---|---|---|
| Mistake noticed late (wrong edit, purge from trash, deleted photo, buggy update) | Time Travel, 7 days, records only | Photo deletes are immediate and permanent; nothing older than 7 days |
| Losing access to the Cloudflare account (email, 2FA, suspension) | None | Every copy lives in one account |

Planned:

1. **Nightly snapshot** ($0): a Worker Cron Trigger writes all records (without embeddings) to
   `backups/` in R2 and keeps 90 days. Photo deletes move objects to a `trash/` prefix kept 90 days
   instead of deleting them. Check the 10 ms CPU limit on Workers Free with ~3,700 rows; chunk if needed.
2. **Off-Cloudflare copy**: either a quarterly reminder to download **Full backup (ZIP)** to
   a personal cloud drive, or a weekly GitHub Action that runs `wrangler d1 export` and
   `rclone copy` of R2 to Google Drive (needs a one-time Google OAuth token as a repo secret).
3. **Account safety** (owner, manual): 2FA on Cloudflare with recovery codes stored safely; a second
   account member under **Manage Account → Members**; domain auto-renew on with a card that won't expire.

### Deleted koozies and photos

Deleting a koozie moves it to **Recently deleted**, where it can be restored for 30 days. A daily
Cron Trigger (`triggers` in `wrangler.jsonc`, `dailyMaintenance` in `src/worker/catalog.ts`) then
erases it with its photos from D1 and R2, and also erases scans that were never saved (after 24 h).
**Delete permanently** in Recently deleted erases one immediately. Removing a single photo from a
koozie erases that photo's file right away.

## Gemini models and overloads

`DESCRIBE_MODEL` is a comma-separated list, tried in order. When a model answers 503 ("high demand",
which can last hours on the free tier) or 429, the next one is used. If every model is busy, scans
still save; the description shows **Try again**, and bulk matching waits and retries.

## Bulk import from a folder (front/back pairs)

`POST /api/admin/bulk/photos` takes `full`/`thumb` plus optional `back_full`/`back_thumb`, so a
koozie's back travels with its front: matched together, saved together, shown together in review.
For a large folder, a script can run the upload and matching against a local Worker whose D1, R2 and
Vectorize bindings are `"remote": true` (with `AUTH_MODE=dev`, which only works on localhost), so
results land in the live review queue without a browser.

## Rebuilding the search index

Use **Tools → Rebuild search index**. It marks every photo as unindexed and re-upserts it into
Vectorize from the embeddings stored in D1, which needs no AI calls if the model is unchanged.
Use it if Vectorize is ever recreated, emptied, or suspected to be out of sync.

## Switching the AI provider, model, or dimension

- **Same provider, different dimension:**
  1. Create `koozid-photos-<dims>` (see DEPLOYMENT §1).
  2. Set `EMBEDDING_DIMS` and `index_name`.
  3. Deploy, then run **Rebuild search index**. Photos are re-embedded because the stored model tag
     changes.
- **Different provider:**
  1. Implement `Embedder` (and optionally `Describer`) from `src/worker/ai/types.ts` (≈50 lines;
     see `gemini.ts`).
  2. Add it to `defaultEmbedder()` in `src/worker/app.ts`, then add the secret.
  3. Rebuild as above.

  Records are never touched. Run `npm run eval` first to compare quality.
- **Thresholds:** after any model change, re-run `npm run eval` and update `MATCH_STRONG` and
  `MATCH_POSSIBLE`.

## Dependencies

```sh
npm outdated
npm update && npm test && npm run build
```

`.npmrc` sets `legacy-peer-deps`, because `@vitejs/plugin-react` declares an optional peer that
npm otherwise trips over. The project has six runtime/tooling dependencies of note: React, Hono,
fflate, Vite, Wrangler, and Vitest.

## Common problems

| Symptom | Cause / fix |
|---|---|
| "Please sign in again" | The Access session expired. Tap **Sign in**. Lengthen the session duration in the Access app. |
| `500 auth_misconfigured` | `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are missing or wrong. Set them in `wrangler.jsonc` and redeploy. |
| `403 This account is not allowed` | The email passed Access but isn't in `ALLOWED_EMAILS`. |
| Scan says "Couldn't search automatically" | The Gemini call failed: missing key, quota, or outage. The item can still be saved, and it's indexed later via **Update search index**. Check `wrangler tail` for the error. |
| "Daily AI limit reached" | The `AI_DAILY_LIMIT` cap was hit. Raise it if usage is genuine. |
| Home shows "N photos aren't searchable yet" | Run **Tools → Update search index**. Any photo that keeps failing shows its error on its item page. |
| HEIC photo rejected on desktop Chrome | Use the phone camera, or set iPhone **Settings → Camera → Formats → Most Compatible**. |
| Worker error 1102 (CPU limit) | Workers Free's 10 ms CPU limit. Upgrade to Workers Paid ($5/mo). |
| Vectorize insert fails at ~6.5k photos | The Free 5M stored-dimension limit. Upgrade to Workers Paid, or move to fewer dimensions. |
