"""Retrieval evaluation for KoozID's duplicate search.

Embeds the labelled fixture set (fixtures/manifest.json), simulates the app's search
(photo-level nearest neighbours collapsed to items by best photo), and reports:

  * recall@1 / recall@5 for queries that ARE in the catalogue (re-shoots, back sides)
  * the top score reached by queries that are NOT owned (colourways, redesigns, look-alikes, novel)
  * suggested MATCH_STRONG / MATCH_POSSIBLE thresholds for wrangler.jsonc
  * the same metrics at several Matryoshka dimensions (truncate + renormalise), so the
    storage/free-tier trade-off of a smaller vector can be judged on evidence.

Providers:
  --provider gemini    (default) needs GEMINI_API_KEY in the environment or .dev.vars
  --provider pixels    a dumb 24x24-pixel + colour-histogram baseline; no network. Useful as a
                       control: a real embedding model should beat it clearly.

Embeddings are cached in scripts/eval/results/ so re-runs are free.
Usage:  python scripts/eval/run_eval.py [--provider gemini|pixels] [--fixtures DIR] [--model gemini-embedding-2]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RESULTS = os.path.join(ROOT, "scripts", "eval", "results")
DIMS = [3072, 1536, 768, 512, 256]


def load_key() -> str:
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    p = os.path.join(ROOT, ".dev.vars")
    if os.path.exists(p):
        for line in open(p, encoding="utf8"):
            if line.strip().startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    return ""


def gemini_embed(path: str, key: str, model: str, dims: int) -> tuple[np.ndarray, float]:
    data = base64.b64encode(open(path, "rb").read()).decode()
    body = json.dumps({
        "content": {"parts": [{"inlineData": {"mimeType": "image/jpeg", "data": data}}]},
        "outputDimensionality": dims,
    }).encode()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent"
    for attempt in range(6):
        req = urllib.request.Request(url, body, {"content-type": "application/json", "x-goog-api-key": key})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.load(r)
            vals = (j.get("embedding") or (j.get("embeddings") or [{}])[0]).get("values")
            return np.array(vals, np.float32), time.time() - t0
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            if e.code == 429 or e.code >= 500:
                wait = 2 ** attempt * 5
                print(f"  {e.code} – retrying in {wait}s: {msg[:120]}", file=sys.stderr)
                time.sleep(wait)
                continue
            raise SystemExit(f"Gemini error {e.code}: {msg}")
    raise SystemExit("Gemini kept rate-limiting; try again later")


def pixels_embed(path: str) -> np.ndarray:
    from PIL import Image
    im = Image.open(path).convert("RGB")
    w, h = im.size
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))
    tiny = np.asarray(im.resize((24, 24)), np.float32).ravel() / 255.0
    hsv = np.asarray(im.resize((64, 64)).convert("HSV"), np.float32).reshape(-1, 3)
    hist, _ = np.histogramdd(hsv, bins=(12, 4, 4), range=((0, 256), (0, 256), (0, 256)))
    v = np.concatenate([tiny - tiny.mean(), hist.ravel() / hist.sum() * 8])
    return v.astype(np.float32)


def unit(v: np.ndarray) -> np.ndarray:
    return v / (np.linalg.norm(v) or 1.0)


def evaluate(cat_vecs, cat_items, queries, q_vecs, dims):
    """Return per-query results at a given dimensionality."""
    C = np.stack([unit(v[:dims]) for v in cat_vecs])
    out = []
    for q, qv in zip(queries, q_vecs):
        scores = C @ unit(qv[:dims])
        best: dict[str, float] = {}
        for item, s in zip(cat_items, scores):
            best[item] = max(best.get(item, -1.0), float(s))
        ranked = sorted(best.items(), key=lambda kv: -kv[1])
        exp = q["item"]
        rank = next((i + 1 for i, (it, _) in enumerate(ranked) if it == exp), None) if exp else None
        out.append({
            "file": q["file"], "kind": q["kind"], "expected": exp, "rank": rank,
            "top_item": ranked[0][0], "top_score": ranked[0][1],
            "true_score": best.get(exp) if exp else None,
            # best score among items that are NOT the right answer (distractor strength)
            "best_wrong": max(s for it, s in ranked if it != exp),
            "top5": ranked[:5],
        })
    return out


def summarise(res, dims):
    pos = [r for r in res if r["expected"]]
    neg = [r for r in res if not r["expected"]]
    r1 = sum(1 for r in pos if r["rank"] == 1) / len(pos)
    r5 = sum(1 for r in pos if r["rank"] and r["rank"] <= 5) / len(pos)
    true_scores = sorted(r["true_score"] for r in pos)
    wrong_tops = sorted([r["top_score"] for r in neg] + [r["best_wrong"] for r in pos])
    # Strong: above every wrong-item score seen (no false "strong" on this set).
    strong = round(max(wrong_tops) + 0.005, 3)
    # Possible: keeps ~95% of true matches above it.
    possible = round(true_scores[max(0, int(len(true_scores) * 0.05) - 0)] - 0.005, 3)
    margin = min(true_scores) - max(wrong_tops)
    by_kind = {}
    for r in res:
        by_kind.setdefault(r["kind"], []).append(r)
    return {
        "dims": dims, "recall@1": r1, "recall@5": r5,
        "true_min": min(true_scores), "true_median": statistics.median(true_scores),
        "wrong_max": max(wrong_tops), "wrong_median": statistics.median(wrong_tops),
        "separation_margin": margin,
        "suggest_strong": strong, "suggest_possible": min(possible, strong),
        "by_kind": {k: {
            "n": len(v),
            "recall@1": (sum(1 for r in v if r["rank"] == 1) / len(v)) if v[0]["expected"] else None,
            "median_top": statistics.median(r["top_score"] for r in v),
            "max_top": max(r["top_score"] for r in v),
        } for k, v in by_kind.items()},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="gemini", choices=["gemini", "pixels"])
    ap.add_argument("--model", default="gemini-embedding-2")
    ap.add_argument("--fixtures", default=os.path.join(ROOT, "fixtures"))
    args = ap.parse_args()

    manifest = json.load(open(os.path.join(args.fixtures, "manifest.json")))
    img = lambda f: os.path.join(args.fixtures, "images", f)
    cat_files, cat_items = [], []
    for c in manifest["catalog"]:
        for f in c["photos"]:
            cat_files.append(f)
            cat_items.append(c["key"])
    queries = manifest["queries"]

    os.makedirs(RESULTS, exist_ok=True)
    tag = args.provider if args.provider == "pixels" else args.model
    cache_path = os.path.join(RESULTS, f"embeddings-{tag}.json")
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    latencies = []
    key = load_key() if args.provider == "gemini" else ""
    if args.provider == "gemini" and not key:
        raise SystemExit("GEMINI_API_KEY not found (env or .dev.vars). Use --provider pixels for the offline baseline.")

    def emb(f):
        if f not in cache:
            if args.provider == "gemini":
                v, dt = gemini_embed(img(f), key, args.model, 3072)
                latencies.append(dt)
            else:
                v = pixels_embed(img(f))
            cache[f] = v.tolist()
            json.dump(cache, open(cache_path, "w"))
        return np.array(cache[f], np.float32)

    all_files = cat_files + [q["file"] for q in queries]
    for i, f in enumerate(all_files):
        emb(f)
        print(f"\rembedded {i + 1}/{len(all_files)}", end="", file=sys.stderr)
    print(file=sys.stderr)
    cat_vecs = [emb(f) for f in cat_files]
    q_vecs = [emb(q["file"]) for q in queries]

    full_dim = len(cat_vecs[0])
    dims_list = [d for d in DIMS if d <= full_dim] if args.provider == "gemini" else [full_dim]
    report = {"provider": tag, "catalog_items": len(manifest["catalog"]), "catalog_photos": len(cat_files),
              "queries": len(queries), "latency_s": {"median": statistics.median(latencies), "max": max(latencies)} if latencies else None,
              "results": []}
    lines = [f"# Retrieval eval - {tag}", "",
             f"{len(manifest['catalog'])} catalogue items / {len(cat_files)} photos, {len(queries)} queries "
             f"({sum(1 for q in queries if q['item'])} owned, {sum(1 for q in queries if not q['item'])} not owned).", ""]
    if latencies:
        lines.append(f"Embedding latency (this machine → API): median {statistics.median(latencies):.2f}s, max {max(latencies):.2f}s\n")
    lines += ["| dims | recall@1 | recall@5 | true-match score min / median | best wrong score max / median | margin | suggested strong / possible |",
              "|---|---|---|---|---|---|---|"]
    detail = None
    for d in dims_list:
        res = evaluate(cat_vecs, cat_items, queries, q_vecs, d)
        s = summarise(res, d)
        report["results"].append({"summary": s, "queries": res})
        lines.append(f"| {d} | {s['recall@1']:.0%} | {s['recall@5']:.0%} | {s['true_min']:.3f} / {s['true_median']:.3f} | "
                     f"{s['wrong_max']:.3f} / {s['wrong_median']:.3f} | {s['separation_margin']:+.3f} | {s['suggest_strong']} / {s['suggest_possible']} |")
        if d == 768 or detail is None:
            detail = (d, s, res)
    d, s, res = detail
    lines += ["", f"## By query kind at {d} dims", "", "| kind | n | recall@1 | median top score | max top score |", "|---|---|---|---|---|"]
    for k, v in s["by_kind"].items():
        r1 = "-" if v["recall@1"] is None else f"{v['recall@1']:.0%}"
        lines.append(f"| {k} | {v['n']} | {r1} | {v['median_top']:.3f} | {v['max_top']:.3f} |")
    lines += ["", f"## Misses and hardest negatives at {d} dims", ""]
    for r in res:
        if (r["expected"] and r["rank"] != 1) or (not r["expected"] and r["top_score"] >= s["suggest_possible"]):
            lines.append(f"- `{r['file']}` ({r['kind']}): expected **{r['expected'] or 'no match'}**, top = {r['top_item']} "
                         f"({r['top_score']:.3f})" + (f", true item rank {r['rank']} ({r['true_score']:.3f})" if r["expected"] else ""))
    text = "\n".join(lines)
    print(text)
    open(os.path.join(RESULTS, f"report-{tag}.md"), "w", encoding="utf8").write(text)
    json.dump(report, open(os.path.join(RESULTS, f"report-{tag}.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
