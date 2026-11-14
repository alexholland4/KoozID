# Deployment

Nothing here has been run against your accounts yet. Every step creates resources in **your**
Cloudflare and Google accounts. All of them are free-tier unless noted.

## 0. Prerequisites

- Node 20+ and `npm install` in the `app/` folder. Run every command below from `app/`.
- A Cloudflare account, then `npx wrangler login`
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey). The free tier needs
  no billing, but free-tier content may be used to improve Google's products. To opt out of that,
  link a billing account (paid tier, ≈ cents per month here).

## 1. Create resources

```sh
npx wrangler d1 create koozid                    # copy database_id into wrangler.jsonc
npx wrangler r2 bucket create koozid-photos      # may prompt you to add a payment method first
npx wrangler vectorize create koozid-photos-512 --dimensions=512 --metric=cosine
```

If you change `EMBEDDING_DIMS`, create an index with matching `--dimensions`, use a name that
records it (e.g. `koozid-photos-512`), and update `index_name` in `wrangler.jsonc`.

## 2. Schema and secrets

```sh
npm run db:migrate:remote
npx wrangler secret put GEMINI_API_KEY
```

## 3. First deploy (workers.dev)

```sh
npm run deploy        # vite build + wrangler deploy
```

The app is now at `https://koozid.<your-subdomain>.workers.dev`. It answers every `/api` call with
`500 auth_misconfigured` until Access is set up. That's intentional: it fails closed.

## 4. Cloudflare Access (login)

1. Open the Cloudflare dashboard, go to **Zero Trust**, and pick a team name. You'll get
   `https://<team>.cloudflareaccess.com`. Choose the **Free** plan.
2. Go to **Settings → Authentication** and make sure **One-time PIN** is enabled. It's on by default.
3. Protect the Worker:
   - **workers.dev now:** go to **Workers & Pages → koozid → Settings → Domains & Routes** and
     enable Cloudflare Access on `workers.dev`. Copy the **AUD** tag shown.
   - **Custom domain later (§7):** go to **Access → Applications → Add → Self-hosted**, set the
     domain to `koozid.example.com`, and copy the **Application Audience (AUD) tag**.
4. Policy: **Allow** → Include → **Emails** → your brother's address and yours.
5. **Session duration:** 1 month, so the home-screen app rarely asks for a code. (iOS keeps a
   separate cookie jar for home-screen apps, so sign in once from inside the installed app.)
6. In `wrangler.jsonc` `vars`, set:
   ```jsonc
   "ACCESS_TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
   "ACCESS_AUD": "<aud tag>",
   ```
   The email lists are secrets, kept out of git:
   ```sh
   printf 'you@example.com, brother@example.com' | npx wrangler secret put ALLOWED_EMAILS   # second line of defence
   printf 'you@example.com' | npx wrangler secret put ADMIN_EMAILS                         # import/reindex/demo tools
   ```
   In the 2026 dashboard, step 3's "workers.dev now" option lives under **koozid → Access → Protect this
   Worker behind Access**. Choose **All traffic** and a reusable policy created under
   **Zero Trust → Access → Policies**.
7. Run `npm run deploy` again.

### Guest view: protect only `/api` and `/signin`

The site's front page is a public, read-only guest view (`/pub/*`, see `src/worker/public.ts`).
Access must therefore cover only the signed-in parts, not the whole hostname:

1. **Zero Trust → Access → Applications**, open the KoozID application, **Configure / Edit**.
2. Under the application's destinations (public hostnames), replace the single `koozid.com`
   entry with two: domain `koozid.com` path `api`, and domain `koozid.com` path `signin`.
   Keep the same "KoozID users" policy. The AUD tag stays the same when you edit the existing app.
3. If the app came from **Workers → koozid → Protect this Worker behind Access** and its destinations
   can't be edited, delete it, create a **Self-hosted** application with those two destinations
   and the same policy, and put its new AUD in `ACCESS_AUD`, then redeploy.

Check it:

```sh
curl -sI https://koozid.com/            # 200 (public page shell)
curl -s  https://koozid.com/pub/stats   # JSON count, no sign-in
curl -sI https://koozid.com/api/stats   # 302 to <team>.cloudflareaccess.com
curl -sI https://koozid.com/signin      # 302 to <team>.cloudflareaccess.com
```

The Worker verifies the Access token on every `/api` request regardless, so a mistake in these
paths can't expose private data; it can only make sign-in fail.

## 5. Verify production access

```sh
curl -sI https://koozid.<sub>.workers.dev/            # expect 302 to <team>.cloudflareaccess.com
curl -s  https://koozid.<sub>.workers.dev/api/stats   # expect a redirect, never JSON
```

Then, in a phone browser:

1. Open the URL, enter your email, then the PIN. The dashboard loads.
2. Tap **Scan Koozie**, take a photo, and check that results appear and a description is suggested.
3. **Share → Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome).
4. In **Tools**, check that the About box shows `gemini (...)` and `index: vectorize`.

Optional demo data: `node scripts/seed-demo.mjs --url https://koozid.<sub>.workers.dev`. It needs
an Access **service token**: create one under **Access → Service credentials**, add an Allow policy
with the **Service Token** selector, and put its client id in `SERVICE_TOKEN_CLIENT_IDS`. Then
export `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`. Remove the demo data later with
**Tools → Remove demo data**.

## 6. Calibrate match thresholds

```sh
echo GEMINI_API_KEY=... >> .dev.vars
npm run eval                                       # python 3 + numpy + pillow
```

Copy the suggested `MATCH_STRONG` / `MATCH_POSSIBLE` into `wrangler.jsonc`, then redeploy.
Repeat with real photos once the collection is imported ([EVALUATION.md](EVALUATION.md)).

## 7. Custom domain

Workers custom domains and Access applications need the domain to be an active zone in
Cloudflare (a CNAME to `*.workers.dev` isn't enough). Add the zone on the Free plan, then set
`routes` in `wrangler.jsonc` and redeploy; Cloudflare issues the certificate.

## 8. Email (koozie offers and thank-yous)

The contribute flow sends three emails: a heads-up to the collector when someone offers a koozie,
the mailing address once he approves, and a "You're part of the journey" thank-you once it's
cataloged. Until email is connected, each of these opens in the collector's own mail app, prefilled
("Open in Mail" on the Koozie offers page), so nothing is blocked. The heads-up needs email; without
it new offers only show in the app.

koozid.com uses two providers side by side, which DNS allows because they use different records:

| | Resend (the app sends) | Zoho Mail (Bobby's inbox) |
|---|---|---|
| MX | `send.koozid.com` (bounces only) | `koozid.com` (mx.zoho.com …) |
| SPF | TXT on `send.koozid.com` | TXT on `koozid.com`: `v=spf1 include:zohomail.com ~all` |
| DKIM | TXT `resend._domainkey` | TXT `zmail._domainkey` (selector Zoho gives you) |

Keep a single SPF record on `koozid.com` (Zoho's) and a single `_dmarc` record, e.g.
`v=DMARC1; p=none;`. Don't turn on Cloudflare Email Routing: it would take over the `koozid.com` MX.

Resend, already configured in `wrangler.jsonc` (`EMAIL_PROVIDER` "resend", From
`bobby@koozid.com`, so replies land in Zoho). It stays off until the API key exists:

1. At [resend.com](https://resend.com), go to **Domains → Add domain** → `koozid.com`, and
   **Auto configure** with Cloudflare (or copy its records into Cloudflare → koozid.com → DNS,
   with the proxy off). Wait for **Verified**.
2. **API Keys → Create**, permission **Sending access**, domain `koozid.com`. Then:
   ```sh
   npx wrangler secret put RESEND_API_KEY
   printf 'bobby@koozid.com' | npx wrangler secret put NOTIFY_EMAILS   # who hears about new offers
   ```
   A secret takes effect right away, with no redeploy needed.
3. In **Tools → Contributions**, tap **Send me a test email**. It shows Resend's own error if
   something isn't right yet.

The free plan sends 3,000 emails a month and 100 a day. Switching provider means adding a new
class in `src/worker/mail.ts`.

## Updating

```sh
git pull && npm ci && npm test && npm run deploy
npm run db:migrate:remote      # only when a new file appears in migrations/
```
