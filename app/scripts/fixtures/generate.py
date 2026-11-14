"""Generate a synthetic, fully-licensed koozie photo set with ground-truth labels.

Real koozie photos aren't available yet, so this renders cylindrical koozies with
fictional brands and then "photographs" them under varied conditions. The set is
built to exercise the cases that matter for duplicate search:

  * reshoot      – the same koozie photographed again (different angle/light/background)
  * back         – the opposite side of a catalogued koozie (different print)
  * colorway     – a known design printed on a different koozie colour (NOT owned)
  * redesign     – same brand, meaningfully different artwork (NOT owned)
  * lookalike    – different brand, similar colours/layout (NOT owned)
  * novel        – completely new design (NOT owned)

Output: fixtures/images/*.jpg and fixtures/manifest.json
Usage:  python scripts/fixtures/generate.py   (deterministic; seed fixed)
"""

from __future__ import annotations

import json
import math
import os
import random
from dataclasses import dataclass, field, asdict

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(ROOT, "fixtures")
IMG_DIR = os.path.join(OUT_DIR, "images")

FONT_CANDIDATES = {
    "bold": ["arialbd.ttf", "DejaVuSans-Bold.ttf", "Arial Bold.ttf"],
    "impact": ["impact.ttf", "DejaVuSans-Bold.ttf"],
    "serif": ["georgiab.ttf", "timesbd.ttf", "DejaVuSerif-Bold.ttf"],
    "script": ["segoesc.ttf", "comicbd.ttf", "DejaVuSans-Oblique.ttf"],
}
FONT_DIRS = ["C:/Windows/Fonts", "/usr/share/fonts/truetype/dejavu", "/Library/Fonts", "/System/Library/Fonts"]


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    for name in FONT_CANDIDATES[kind]:
        for d in FONT_DIRS:
            p = os.path.join(d, name)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default(size=size)


COLORS = {
    "green": (24, 92, 52), "navy": (22, 38, 84), "red": (178, 30, 38), "black": (24, 24, 26),
    "white": (236, 236, 232), "orange": (232, 112, 28), "royal": (30, 76, 178), "maroon": (110, 24, 40),
    "yellow": (240, 196, 40), "teal": (20, 128, 130), "pink": (226, 92, 150), "gray": (128, 130, 134),
    "camo": (88, 96, 62), "purple": (88, 44, 140), "gold": (196, 156, 60), "sky": (110, 176, 226),
}


@dataclass
class Design:
    key: str
    brand: str
    tagline: str
    body: str            # koozie colour name
    ink: str             # primary print colour
    accent: str          # secondary print colour
    emblem: str          # circle|star|diamond|shield|wave|anchor|none
    font: str
    layout: str          # stacked|banner|badge|vertical
    back_text: str = ""  # text printed on the back side (if any)


# Catalogue designs (things the collector already owns)
OWNED: list[Design] = [
    Design("lions-2019", "LAKESIDE LIONS", "Fall Classic 2019", "green", "yellow", "white", "shield", "impact", "stacked", "GO LIONS!"),
    Design("gulf-shores", "GULF SHORES", "Sun · Sand · Suds", "sky", "white", "orange", "wave", "script", "banner", "Est. 1998"),
    Design("smith-reunion", "SMITH FAMILY", "Reunion 2021", "orange", "black", "white", "none", "serif", "badge"),
    Design("hoppy-trails", "HOPPY TRAILS", "Brewing Co.", "black", "gold", "white", "circle", "serif", "badge", "Drink Local"),
    Design("bayou-bash", "BAYOU BASH", "Crawfish Boil", "purple", "gold", "white", "star", "impact", "stacked"),
    Design("mile-high", "MILE HIGH", "Golf Classic", "navy", "white", "sky", "diamond", "bold", "banner", "Hole in One Sponsor"),
    Design("big-catch", "BIG CATCH", "Bait & Tackle", "camo", "orange", "black", "anchor", "impact", "vertical"),
    Design("cactus-run", "CACTUS RUN", "5K · 2018", "teal", "white", "yellow", "star", "bold", "stacked"),
    Design("jenna-mike", "JENNA & MIKE", "06.14.2020", "white", "pink", "gold", "circle", "script", "badge"),
    Design("redline-auto", "REDLINE AUTO", "Parts & Service", "red", "white", "black", "diamond", "impact", "banner", "Call 555-0142"),
    Design("ozark-float", "OZARK FLOAT", "Trip 2017", "maroon", "white", "gold", "wave", "bold", "stacked"),
    Design("tailgate-co", "TAILGATE CO.", "Game Day Ready", "gray", "red", "white", "shield", "bold", "badge"),
    Design("sunset-marina", "SUNSET MARINA", "Lake Lanier", "orange", "navy", "white", "anchor", "serif", "banner"),
    Design("polar-pub", "POLAR PUB", "Keep It Cold", "royal", "white", "sky", "circle", "impact", "stacked", "Since 1976"),
    Design("lucky-13", "LUCKY 13", "Bowling League", "black", "red", "white", "star", "impact", "badge"),
    Design("pine-ridge", "PINE RIDGE", "Summer Camp", "green", "white", "orange", "none", "serif", "stacked"),
    Design("hogs-heat", "HOGS & HEAT", "BBQ Cook-Off", "yellow", "black", "red", "shield", "impact", "stacked"),
    Design("coastal-cu", "COASTAL CU", "Member Day", "teal", "white", "gold", "wave", "bold", "banner"),
    Design("dad-bod", "DAD BOD", "Fan Club", "navy", "orange", "white", "none", "impact", "vertical"),
    Design("river-rats", "RIVER RATS", "Tubing Crew", "sky", "black", "yellow", "wave", "impact", "badge"),
]

# Colourways of owned designs that are also already OWNED (both count as unique items)
OWNED_COLORWAYS = [("lions-2019", "navy", "lions-2019-navy"), ("polar-pub", "black", "polar-pub-black")]

# Near-miss items the collector does NOT own (queries that should NOT be called duplicates)
NOT_OWNED: list[tuple[str, Design]] = [
    ("colorway", Design("hoppy-trails-red", "HOPPY TRAILS", "Brewing Co.", "red", "gold", "white", "circle", "serif", "badge")),
    ("colorway", Design("bayou-bash-green", "BAYOU BASH", "Crawfish Boil", "green", "gold", "white", "star", "impact", "stacked")),
    ("colorway", Design("mile-high-white", "MILE HIGH", "Golf Classic", "white", "navy", "sky", "diamond", "bold", "banner")),
    ("redesign", Design("lions-2021", "LAKESIDE LIONS", "Fall Classic 2021", "green", "white", "yellow", "star", "bold", "banner")),
    ("redesign", Design("gulf-shores-24", "GULF SHORES", "Spring Break '24", "sky", "orange", "white", "circle", "impact", "stacked")),
    ("redesign", Design("cactus-run-22", "CACTUS RUN", "10K · 2022", "teal", "yellow", "white", "diamond", "impact", "badge")),
    ("lookalike", Design("lakeview-lynx", "LAKEVIEW LYNX", "Homecoming 2019", "green", "yellow", "white", "shield", "impact", "stacked")),
    ("lookalike", Design("coastal-bank", "COASTAL BANK", "Customer Day", "teal", "white", "gold", "wave", "bold", "banner")),
    ("lookalike", Design("lucky-7", "LUCKY 7", "Darts League", "black", "red", "white", "star", "impact", "badge")),
    ("novel", Design("taco-tues", "TACO TUESDAY", "Every Week", "yellow", "red", "green", "circle", "script", "badge")),
    ("novel", Design("north-star", "NORTH STAR", "Snowmobile Club", "white", "royal", "red", "star", "serif", "banner")),
    ("novel", Design("buck-wild", "BUCK WILD", "Deer Camp", "camo", "white", "orange", "none", "impact", "vertical")),
]


# --------------------------------------------------------------------------- render

def draw_emblem(d: ImageDraw.ImageDraw, kind: str, cx: int, cy: int, r: int, ink, accent):
    if kind == "circle":
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ink, width=max(4, r // 8))
        d.ellipse([cx - r // 2, cy - r // 2, cx + r // 2, cy + r // 2], fill=accent)
    elif kind == "star":
        pts = []
        for i in range(10):
            ang = -math.pi / 2 + i * math.pi / 5
            rr = r if i % 2 == 0 else r * 0.45
            pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
        d.polygon(pts, fill=ink, outline=accent)
    elif kind == "diamond":
        d.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=ink)
        d.polygon([(cx, cy - r // 2), (cx + r // 2, cy), (cx, cy + r // 2), (cx - r // 2, cy)], fill=accent)
    elif kind == "shield":
        d.polygon([(cx - r, cy - r), (cx + r, cy - r), (cx + r, cy + r // 4), (cx, cy + r), (cx - r, cy + r // 4)], fill=ink)
        d.rectangle([cx - r // 6, cy - r * 0.8, cx + r // 6, cy + r * 0.6], fill=accent)
    elif kind == "wave":
        for k in range(3):
            pts = [(cx - r + t, cy - r // 3 + k * r // 3 + int(r * 0.18 * math.sin(t / r * 2 * math.pi))) for t in range(0, 2 * r, 4)]
            d.line(pts, fill=ink if k != 1 else accent, width=max(5, r // 7))
    elif kind == "anchor":
        d.line([(cx, cy - r), (cx, cy + r)], fill=ink, width=max(6, r // 6))
        d.line([(cx - r * 0.6, cy - r * 0.4), (cx + r * 0.6, cy - r * 0.4)], fill=ink, width=max(6, r // 6))
        d.arc([cx - r, cy - r * 0.2, cx + r, cy + r * 1.1], 20, 160, fill=accent, width=max(6, r // 6))
        d.ellipse([cx - r // 4, cy - r * 1.25, cx + r // 4, cy - r * 0.75], outline=ink, width=6)


def centered(d, y, text, f, fill, W):
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


def fit_font(d, text, kind, start, max_w):
    size = start
    while size > 14:
        f = font(kind, size)
        if d.textlength(text, font=f) <= max_w:
            return f
        size -= 4
    return font(kind, 14)


def print_layer(design: Design, side: str, W=900, H=1000) -> Image.Image:
    """Flat artwork (the 'unrolled' koozie print area) for one side."""
    body = COLORS[design.body]
    ink, accent = COLORS[design.ink], COLORS[design.accent]
    img = Image.new("RGB", (W, H), body)
    d = ImageDraw.Draw(img)
    if side == "back":
        if design.back_text:
            f = fit_font(d, design.back_text, design.font, 110, W * 0.8)
            centered(d, H * 0.42, design.back_text, f, ink, W)
        return img
    L = design.layout
    if L == "stacked":
        draw_emblem(d, design.emblem, W // 2, int(H * 0.27), 150, ink, accent)
        f = fit_font(d, design.brand, design.font, 140, W * 0.86)
        centered(d, H * 0.52, design.brand, f, ink, W)
        centered(d, H * 0.70, design.tagline, fit_font(d, design.tagline, "bold", 70, W * 0.8), accent, W)
    elif L == "banner":
        d.rectangle([0, H * 0.36, W, H * 0.60], fill=ink)
        f = fit_font(d, design.brand, design.font, 140, W * 0.86)
        centered(d, H * 0.39, design.brand, f, body, W)
        draw_emblem(d, design.emblem, W // 2, int(H * 0.19), 110, accent, ink)
        centered(d, H * 0.68, design.tagline, fit_font(d, design.tagline, "bold", 72, W * 0.8), ink, W)
    elif L == "badge":
        d.ellipse([W * 0.12, H * 0.12, W * 0.88, H * 0.88], outline=ink, width=18)
        d.ellipse([W * 0.17, H * 0.17, W * 0.83, H * 0.83], outline=accent, width=6)
        draw_emblem(d, design.emblem, W // 2, int(H * 0.30), 80, accent, ink)
        f = fit_font(d, design.brand, design.font, 120, W * 0.62)
        centered(d, H * 0.45, design.brand, f, ink, W)
        centered(d, H * 0.62, design.tagline, fit_font(d, design.tagline, "bold", 60, W * 0.55), accent, W)
    elif L == "vertical":
        txt = Image.new("RGBA", (H, W // 2), (0, 0, 0, 0))
        td = ImageDraw.Draw(txt)
        f = fit_font(td, design.brand, design.font, 170, H * 0.9)
        td.text((H * 0.05, 40), design.brand, font=f, fill=ink + (255,))
        img.paste(txt.rotate(90, expand=True), (int(W * 0.08), 0), txt.rotate(90, expand=True))
        centered(d, H * 0.82, design.tagline, fit_font(d, design.tagline, "bold", 66, W * 0.5), accent, W)
        d.text((W * 0.60, H * 0.2), "", fill=ink)
    return img


def wrap_cylinder(art: Image.Image, out_w=560, out_h=680) -> Image.Image:
    """Project flat artwork onto a lit cylinder seen from the front (RGBA)."""
    a = np.asarray(art.resize((art.width, out_h - 80))).astype(np.float32)
    aw = a.shape[1]
    cyl = np.zeros((out_h, out_w, 4), np.float32)
    xs = (np.arange(out_w) + 0.5) / out_w * 2 - 1           # -1..1 across visible width
    theta = np.arcsin(np.clip(xs, -1, 1))                   # angle on cylinder
    src_x = ((theta / (math.pi / 2)) * 0.5 + 0.5) * (aw - 1) * 0.92 + aw * 0.04
    light = 0.55 + 0.45 * np.cos(theta - 0.35)              # key light from left
    spec = np.exp(-((theta + 0.45) ** 2) / 0.01) * 0.35     # specular stripe
    for j in range(out_w):
        col = a[:, int(src_x[j]), :3] * light[j] + 255 * spec[j]
        cyl[40:out_h - 40, j, :3] = col
        cyl[40:out_h - 40, j, 3] = 255
    img = Image.fromarray(np.clip(cyl, 0, 255).astype(np.uint8), "RGBA")
    d = ImageDraw.Draw(img)
    body = tuple(int(v) for v in a[5, aw // 2, :3])
    # Rounded top/bottom rims and stitched seams
    for y0 in (0, out_h - 80):
        d.ellipse([0, y0, out_w - 1, y0 + 80], fill=tuple(int(c * 0.8) for c in body) + (255,))
    d.ellipse([10, 6, out_w - 11, 70], fill=(30, 30, 30, 255))   # opening
    for y in (56, out_h - 56):
        for x in range(20, out_w - 20, 18):
            d.line([(x, y), (x + 9, y)], fill=(250, 250, 250, 160), width=2)
    return img


def background(rng: random.Random, W, H) -> Image.Image:
    kind = rng.choice(["wood", "counter", "cloth", "carpet"])
    base = {"wood": (122, 84, 52), "counter": (205, 200, 192), "cloth": (60, 70, 90), "carpet": (110, 100, 92)}[kind]
    arr = np.ones((H, W, 3), np.float32) * np.array(base, np.float32)
    nprng = np.random.default_rng(rng.randrange(1 << 30))
    if kind == "wood":
        y = np.arange(H)[:, None]
        arr += (np.sin(y / rng.uniform(6, 14) + nprng.normal(0, 0.3, (H, W)) * 0.5) * 18)[..., None]
    arr += nprng.normal(0, 7, (H, W, 1))
    g = np.linspace(rng.uniform(0.75, 1.0), rng.uniform(0.85, 1.15), W)[None, :, None]
    return Image.fromarray(np.clip(arr * g, 0, 255).astype(np.uint8))


def photograph(koozie: Image.Image, rng: random.Random, W=900, H=1100) -> Image.Image:
    """Place koozie in a scene with random pose, framing and camera artefacts."""
    bg = background(rng, W, H)
    scale = rng.uniform(1.05, 1.45)
    k = koozie.resize((int(koozie.width * scale), int(koozie.height * scale)), Image.BICUBIC)
    k = k.rotate(rng.uniform(-14, 14), resample=Image.BICUBIC, expand=True)
    # mild perspective (camera tilt)
    w, h = k.size
    dx = rng.uniform(-0.08, 0.08) * w
    coeffs = _persp_coeffs([(0, 0), (w, 0), (w, h), (0, h)], [(dx, 0), (w + dx, 0), (w - dx, h), (-dx, h)])
    k = k.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    shadow = Image.new("RGBA", k.size, (0, 0, 0, 0))
    shadow.putalpha(k.getchannel("A").point(lambda v: int(v * 0.45)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    x = int((W - w) / 2 + rng.uniform(-0.1, 0.1) * W)
    y = int((H - h) / 2 + rng.uniform(-0.08, 0.08) * H)
    bg.paste(shadow, (x + 18, y + 22), shadow)
    bg.paste(k, (x, y), k)
    img = ImageEnhance.Brightness(bg).enhance(rng.uniform(0.75, 1.2))
    img = ImageEnhance.Color(img).enhance(rng.uniform(0.85, 1.15))
    temp = rng.uniform(-14, 14)  # white balance shift
    r, g, b = img.split()
    img = Image.merge("RGB", (r.point(lambda v: max(0, min(255, v + temp))), g, b.point(lambda v: max(0, min(255, v - temp)))))
    if rng.random() < 0.4:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.6, 1.6)))
    return img


def _persp_coeffs(src, dst):
    m = []
    for (x, y), (u, v) in zip(dst, src):
        m.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        m.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    A = np.array(m, np.float64)
    B = np.array(src, np.float64).reshape(8)
    return np.linalg.solve(A, B).tolist()


def recolor(d: Design, body: str, key: str) -> Design:
    nd = Design(**{**asdict(d), "key": key, "body": body})
    return nd


# --------------------------------------------------------------------------- build

@dataclass
class Entry:
    file: str
    design: str
    side: str
    item: str | None = None   # catalogue item key this photo belongs to / should match
    kind: str | None = None   # query kind


def main():
    rng = random.Random(20261031)
    os.makedirs(IMG_DIR, exist_ok=True)
    for f in os.listdir(IMG_DIR):
        os.remove(os.path.join(IMG_DIR, f))

    owned = list(OWNED)
    by_key = {d.key: d for d in owned}
    for base, body, key in OWNED_COLORWAYS:
        owned.append(recolor(by_key[base], body, key))

    catalog: list[dict] = []
    queries: list[Entry] = []

    def shoot(design: Design, side: str, name: str) -> str:
        art = print_layer(design, side)
        img = photograph(wrap_cylinder(art), rng)
        fn = f"{name}.jpg"
        img.save(os.path.join(IMG_DIR, fn), "JPEG", quality=82, optimize=True)
        return fn

    for d in owned:
        photos = [shoot(d, "front", f"cat-{d.key}-front")]
        if d.back_text:
            photos.append(shoot(d, "back", f"cat-{d.key}-back"))
        catalog.append({
            "key": d.key, "brand": d.brand.title(), "tagline": d.tagline,
            "description": f"{d.body.title()} koozie with {d.ink} {d.brand.title()} {d.tagline} print",
            "primary_color": d.body, "secondary_color": d.ink, "photos": photos,
        })

    # Positive queries: re-shoots of owned fronts (all), backs where indexed
    for d in owned:
        queries.append(Entry(shoot(d, "front", f"q-reshoot-{d.key}"), d.key, "front", d.key, "reshoot"))
    for d in owned[:8]:
        if d.back_text:
            queries.append(Entry(shoot(d, "back", f"q-back-{d.key}"), d.key, "back", d.key, "back"))
    # Negative queries: items not owned
    for kind, d in NOT_OWNED:
        queries.append(Entry(shoot(d, "front", f"q-{kind}-{d.key}"), d.key, "front", None, kind))

    manifest = {
        "note": "Synthetic koozie photos rendered by scripts/fixtures/generate.py. Fictional brands; free to use.",
        "catalog": catalog,
        "queries": [asdict(q) for q in queries],
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"catalog items: {len(catalog)}  catalog photos: {sum(len(c['photos']) for c in catalog)}  queries: {len(queries)}")


if __name__ == "__main__":
    main()
