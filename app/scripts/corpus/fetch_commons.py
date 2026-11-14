"""Download openly licensed koozie / can-cooler photos from Wikimedia Commons for testing.

Builds fixtures/web-corpus/: downscaled JPEGs (1024px long edge) plus manifest.json recording
each file's source page, author and licence, so the corpus can be attributed and regenerated.
The images themselves are git-ignored; re-run this script to recreate them.

Only files whose licence is public domain / CC0 / CC BY / CC BY-SA are kept. Search hits are
noisy, so look at the downloads and list anything that isn't a koozie in
fixtures/web-corpus/rejected.txt; the next run leaves those out of the manifest.

As of Nov 2026 this yields only ~14 usable photos: openly licensed koozie photos are scarce.

Usage:  python -I scripts/corpus/fetch_commons.py [--max 400]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "fixtures", "web-corpus")
API = "https://commons.wikimedia.org/w/api.php"
UA = "KoozID-corpus/0.1 (private test fixture builder; contact via github.com)"

# Full-text searches over File: pages. Narrow phrases first; noisy ones are filtered by keyword below.
QUERIES = [
    "koozie", "koozies", "coozie", "coozies", "stubby holder", "stubby holders", "stubbie holder",
    "stubby cooler", "beer cozy", "can cozy", "can coozie", "beer koozie", "drink koozie",
    "can sleeve foam", "neoprene can cooler", "foam can cooler", "can insulator", "beverage insulator",
    "huggie can", "can hugger", "bottle cozy", "stubby holder souvenir",
]
CATEGORIES = ["Koozies"]
# Must mention the object itself; "cozy" alone matches people and tea cosies.
KEYWORDS = re.compile(
    r"koozie|coozie|stubb(y|ie)[ -]?(holder|cooler)|(can|beer|drink|bottle|beverage)[ -](cozy|cozie|cosy|cooler|hugger|insulator|sleeve|holder)|huggie",
    re.I,
)
NOT_KOOZIE = re.compile(r"refrigerat|fridge|vending|ice chest|cooler box|esky|portrait|cozy cole|tea cos(y|ie)", re.I)
OK_LICENCE = re.compile(r"^(cc0|pd|public domain|cc[- ]by(-sa)?[- ]?\d|cc by(-sa)? \d)", re.I)


def get(params: dict, tries: int = 6) -> dict:
    params = {**params, "format": "json", "maxlag": "5"}
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read()
            if not body.strip():
                raise ValueError("empty body")
            j = json.loads(body)
            if "error" in j and j["error"].get("code") == "maxlag":
                raise ValueError("maxlag")
            return j
        except (urllib.error.URLError, ValueError, TimeoutError) as e:
            wait = 3 * 2 ** attempt
            print(f"  api retry in {wait}s ({e})", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit("Commons API kept failing")


def imageinfo_params(extra: dict) -> dict:
    return {
        "action": "query",
        "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata",
        "iiurlwidth": "1024",
        "iiextmetadatafilter": "LicenseShortName|Artist|ImageDescription|Credit",
        **extra,
    }


def strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def collect(max_files: int) -> dict[str, dict]:
    found: dict[str, dict] = {}

    def take(pages: dict, via: str):
        for p in pages.values():
            ii = (p.get("imageinfo") or [{}])[0]
            if not ii or ii.get("mime") not in ("image/jpeg", "image/png", "image/webp"):
                continue
            if min(ii.get("width", 0), ii.get("height", 0)) < 300:
                continue
            md = ii.get("extmetadata", {})
            lic = md.get("LicenseShortName", {}).get("value", "")
            if not OK_LICENCE.match(lic.strip()):
                continue
            title = p["title"]
            desc = strip_html(md.get("ImageDescription", {}).get("value", ""))[:400]
            if via != "category" and (not KEYWORDS.search(title + " " + desc) or NOT_KOOZIE.search(title + " " + desc)):
                continue
            found.setdefault(title, {
                "title": title,
                "page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
                "thumb_url": ii.get("thumburl") or ii.get("url"),
                "width": ii.get("width"),
                "height": ii.get("height"),
                "licence": lic,
                "author": strip_html(md.get("Artist", {}).get("value", ""))[:200],
                "description": desc,
                "found_via": via,
            })

    for cat in CATEGORIES:
        j = get(imageinfo_params({"generator": "categorymembers", "gcmtitle": f"Category:{cat}", "gcmtype": "file", "gcmlimit": "200"}))
        take(j.get("query", {}).get("pages", {}), "category")
        time.sleep(1)
    for q in QUERIES:
        offset = 0
        while offset < 300 and len(found) < max_files:
            j = get(imageinfo_params({"generator": "search", "gsrsearch": q, "gsrnamespace": "6", "gsrlimit": "50", "gsroffset": str(offset)}))
            take(j.get("query", {}).get("pages", {}), f"search:{q}")
            nxt = j.get("continue", {}).get("gsroffset")
            print(f"{q!r} offset {offset}: {len(found)} kept so far", file=sys.stderr)
            time.sleep(1.5)
            if not nxt:
                break
            offset = int(nxt)
        if len(found) >= max_files:
            break
    return found


def download(entries: dict[str, dict]):
    from PIL import Image  # noqa: WPS433 - optional dependency, only needed here

    os.makedirs(os.path.join(OUT, "images"), exist_ok=True)
    rej_path = os.path.join(OUT, "rejected.txt")
    rejected = set()
    if os.path.exists(rej_path):
        rejected = {l.strip() for l in open(rej_path, encoding="utf8") if l.strip() and not l.startswith("#")}
    kept = []
    for i, e in enumerate(sorted(entries.values(), key=lambda x: x["title"])):
        if e["title"] in rejected:
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", e["title"].lower().removeprefix("file:"))[:60].strip("-")
        name = f"{slug}-{hashlib.sha1(e['title'].encode()).hexdigest()[:6]}.jpg"
        path = os.path.join(OUT, "images", name)
        if not os.path.exists(path):
            for attempt in range(5):
                try:
                    req = urllib.request.Request(e["thumb_url"], headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=60) as r:
                        data = r.read()
                    im = Image.open(io.BytesIO(data)).convert("RGB")
                    im.thumbnail((1024, 1024))
                    im.save(path, "JPEG", quality=88)
                    break
                except Exception as ex:  # noqa: BLE001 - keep going on any single-file failure
                    wait = 4 * 2 ** attempt
                    print(f"  download retry {name} in {wait}s ({ex})", file=sys.stderr)
                    time.sleep(wait)
            else:
                continue
            time.sleep(1.5)  # upload.wikimedia.org rate-limits bursts
        kept.append({**{k: v for k, v in e.items() if k != "thumb_url"}, "file": name})
        print(f"[{i + 1}/{len(entries)}] {name}", file=sys.stderr)
    return kept


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=400)
    ap.add_argument("--list-only", action="store_true", help="write candidates.json and stop, to review titles first")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    cand_path = os.path.join(OUT, "candidates.json")
    if os.path.exists(cand_path) and not args.list_only:
        entries = json.load(open(cand_path, encoding="utf8"))
    else:
        entries = collect(args.max)
        json.dump(entries, open(cand_path, "w", encoding="utf8"), indent=1)
    print(f"{len(entries)} candidate files", file=sys.stderr)
    if args.list_only:
        return
    kept = download(entries)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf8") as f:
        json.dump({
            "note": "Openly licensed photos from Wikimedia Commons, for testing only. See each entry for author and licence.",
            "generated_at": time.strftime("%Y-%m-%d"),
            "files": kept,
        }, f, indent=1)
    print(f"Wrote {len(kept)} files to {OUT}")


if __name__ == "__main__":
    main()
