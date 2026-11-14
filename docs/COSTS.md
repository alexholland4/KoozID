# Cost assessment

Prices were checked 2026-10-31 against official pages (sources at the bottom). Anything marked
**unverified** came from secondary sources or wasn't re-checked.

## Bottom line

| Situation | Expected monthly cost |
|---|---|
| Up to ~6,500 photos (≈5,000 items), any normal scanning | **$0** (all free tiers) |
| Beyond that, or if Workers Free CPU limits bite | **≈ $5.00–5.10** (Workers Paid; everything else stays inside its included usage) |
| Gemini on the paid tier instead of free, 5–20 scans/day | + ≈ $0.10–0.50 |
| One-time import of 10,000 photos (embeddings, paid tier) | ≈ $1.20 once (free on the free tier, but rate-limited) |

The first limit you'll hit is **Vectorize Free's 5M stored dimensions**. Production uses 512 dims
(since 2026-11-02, when front + back photos made ~7,400 photos likely), which fits ~9,700 photos;
the eval showed no recall loss against 768. 256 dims would fit ~19,500.

## Unit prices

| Service | Free tier | Paid / overage | Notes |
|---|---|---|---|
| Workers | 100k requests/day, **10 ms CPU/request** | $5/mo minimum per account: 10M requests + 30M CPU-ms included | Static asset requests are free and unlimited |
| D1 | 5M rows read/day, 100k rows written/day, 5 GB | In Workers Paid: 25B reads, 50M writes/mo, 5 GB included | Includes 7 days (Free) / 30 days (Paid) Time Travel restore |
| R2 | 10 GB-month, 1M Class A, 10M Class B ops/mo | $0.015/GB-mo, $4.50/M Class A, $0.36/M Class B | **Zero egress fees**. Enabling R2 may require adding a payment method (**unverified**; reports disagree) |
| Vectorize | 5M stored dims, 30M queried dims/mo | In Workers Paid: 10M stored + 50M queried included, then $0.05/100M stored, $0.01/M queried | Queried dims = (queries + stored vectors) × dims |
| Access (Zero Trust) | Free for up to 50 users | — | The Zero Trust signup may ask for a payment method even on Free (**unverified**) |
| Gemini Embedding 2 | Free tier: free; **content used to improve Google products** | $0.45/M image tokens ≈ **$0.00012/image** (Batch API: half) | Free tier RPM/RPD not published per model (**unverified**) |
| Gemini 3.1 Flash-Lite | Free tier: free; same data-use caveat | $0.25/M input, $1.50/M output tokens (prices change 2027-01-01) | ≈ $0.0005–0.001 per description (**estimate**: ~1.3–1.7k input tokens incl. image, ~150 output) |

## Scenarios

Assumptions: 1.3 photos per item, ~0.35 MB stored per photo (full + thumbnail), 768-dim vectors,
20 scans/day (600/month), and descriptions generated only for scans, not imports.

| | Photos | R2 storage | Vectorize stored dims | Within free tiers? | Monthly |
|---|---|---|---|---|---|
| 500 items | 650 | 0.2 GB | 0.5M | Yes | $0 |
| 5,000 items | 6,500 | 2.3 GB | 5.0M (at the limit) | Just | $0 (or 512 dims for headroom) |
| 20,000 items | 26,000 | 9.1 GB | 20M | No (Vectorize) | Workers Paid $5 + ~$0.005 Vectorize overage ≈ **$5.01** |
| Import 10,000 photos (one-time) | +10,000 | +3.5 GB | +7.7M | Embedding calls are rate-limited on free | $0 free tier, or ≈ $1.20 paid |
| Daily use, 5–20 scans | — | negligible | queried: (600 + stored) × 768, well under 30M | Yes | $0 free, or ≈ $0.10–0.50 Gemini paid |

D1 reads: the collection page's `COUNT` + `LIKE` search reads every live row. At 20,000 items,
that's ~250 searches/day on Free (5M rows/day), which is ample for one collector and effectively
unlimited on Paid. Imports write roughly 6 D1 rows per item, so stay under ~15k items/day on Free
(100k writes/day) or spread the import over two days.

## How unexpected charges could happen, and the controls

- **Gemini paid tier.** A runaway client loop could burn tokens. Controls:
  - The app enforces per-day caps (`AI_DAILY_LIMIT` = 300 interactive calls, `AI_DAILY_REINDEX_LIMIT` = 3,000 bulk calls).
  - Only authenticated users can trigger AI calls.
  - Google's Tier 1 has spend-based rate limits ($10 per 10 minutes) and a tier spend cap.
  - Add a Cloud Billing budget alert. Note that budgets alert; they don't cap.
  - Staying on the free tier with no billing account makes charges impossible, at the cost of the data-use caveat.
- **Cloudflare Workers Paid.** Usage above the included amounts is billed. That's practically
  unreachable for this workload: 10M requests and 50M Vectorize queried dimensions are included.
  Turn on billing notifications. On Workers Free, limits are hard stops, not charges.
- **R2.** Storage beyond 10 GB costs $0.015/GB-month (≈ $0.15/month at 20 GB). Abandoned scans are
  deleted after 24 h, so they don't accumulate.
- **Public abuse.** It isn't possible without passing Access: every `/api` call needs a valid Access
  JWT, and Access blocks unauthenticated traffic before the Worker runs.

## Sources

- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini embeddings docs](https://ai.google.dev/gemini-api/docs/embeddings): image input, 128–3072 dims via MRL, ≤6 images/request, PNG/JPEG
- [Gemini rate limits & billing tiers](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Workers pricing (incl. D1, R2, Vectorize, KV)](https://developers.cloudflare.com/workers/platform/pricing/)
- [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/): no image-embedding model
- [Access self-hosted apps](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/): requires an active Cloudflare zone
- [workers.dev routing / Access on workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- Secondary sources for the R2 / Zero Trust payment-method questions (unverified): [costbench Zero Trust free plan](https://costbench.com/software/business-vpn/cloudflare-zero-trust/free-plan/), [freetier.co R2](https://freetier.co/directory/products/cloudflare-r2)
