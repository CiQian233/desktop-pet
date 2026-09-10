"""Bucket the cat's fur by colour family inside a tight face crop, render the
masks so they can be eyeballed, and take medians from the pixels that hit fur.

Also renders the resulting palette as a band under the photo for A/B checking.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
PHOTO = ROOT / "Picture"
OUT = ROOT / "art" / "palette"

# (photo, box) -- tight around the cat only
CROPS = {
    "1789017258615.jpg": (1500, 820, 2700, 2350),   # face-on closeup
    "1789017258703.jpg": (1300, 900, 2500, 2500),   # face-on, wider
    "1789017258671.jpg": (1000, 750, 2400, 2400),   # profile
}


def hsv(rgb: np.ndarray):
    r, g, b = rgb[..., 0] / 255, rgb[..., 1] / 255, rgb[..., 2] / 255
    mx, mn = rgb.max(-1) / 255, rgb.min(-1) / 255
    d = mx - mn
    h = np.zeros_like(mx)
    s = np.zeros_like(mx)
    nz = d > 1e-6
    rn, gn, bn = np.where(nz, r, 1), np.where(nz, g, 1), np.where(nz, b, 1)
    dd = np.where(nz, d, 1)
    h = np.where((mx == r) & nz, ((gn - bn) / dd) % 6, h)
    h = np.where((mx == g) & nz, (bn - rn) / dd + 2, h)
    h = np.where((mx == b) & nz, (rn - gn) / dd + 4, h)
    h = (h * 60) % 360
    s = np.where(mx > 1e-6, d / np.where(mx > 1e-6, mx, 1), 0)
    return h, s, mx


def luma(c):
    return c @ np.array([0.2126, 0.7152, 0.0722])


def hexs(c):
    return "#%02X%02X%02X" % tuple(int(round(v)) for v in c)


TINTS = {
    "orange": (255, 90, 0),
    "white": (0, 230, 60),
    "dark": (60, 110, 255),
    "eye": (255, 0, 230),
}


def bucketed(rgb: np.ndarray) -> dict[str, np.ndarray]:
    h, s, v = hsv(rgb)
    white = (s < 0.14) & (v > 0.78) & (v < 0.995)
    dark = v < 0.34
    orange = (h >= 14) & (h <= 46) & (s > 0.26) & (v > 0.40) & (v < 0.90)
    eye = (h >= 50) & (h <= 120) & (s > 0.16) & (v > 0.30) & (v < 0.80)
    return {"orange": orange, "white": white, "dark": dark, "eye": eye}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pools: dict[str, list[np.ndarray]] = {"orange": [], "white": [], "dark": [], "eye": []}
    panels = []

    for name, box in CROPS.items():
        rgb = np.asarray(Image.open(PHOTO / name).convert("RGB"), dtype=np.float64)
        x0, y0, x1, y1 = box
        crop = rgb[y0:y1, x0:x1]
        masks = bucketed(crop)
        for k, m in masks.items():
            if m.sum() > 50:
                pools[k].append(crop[m])

        # panel: original + 4 tinted masks, all downscaled to 300px wide
        tiles = []
        base = Image.fromarray(crop.astype(np.uint8))
        base.thumbnail((300, 300))
        tiles.append(("original", base))
        for k, tint in TINTS.items():
            m = masks[k]
            ov = crop.copy()
            ov[m] = 0.35 * ov[m] + 0.65 * np.array(tint)
            ov[~m] *= 0.25
            t = Image.fromarray(ov.astype(np.uint8))
            t.thumbnail((300, 300))
            tiles.append((f"{k} {100*m.mean():.0f}%", t))
        panels.append((name, tiles))

    print("=== bucket coverage / medians ===")
    med = {}
    for k, plist in pools.items():
        if not plist:
            print(f"  {k}: empty")
            continue
        pix = np.concatenate(plist, axis=0)
        m = np.median(pix, axis=0)
        med[k] = m
        print(f"  {k:7s} {len(pix):>9,} px   median {hexs(m)}")

    # ---- derive the pixel palette ----------------------------------------
    def layered(key, lo_pct, hi_pct):
        pix = np.concatenate(pools[key], axis=0)
        l = luma(pix)
        lo, hi = np.percentile(l, lo_pct), np.percentile(l, hi_pct)
        return np.median(pix[(l >= lo) & (l <= hi)], axis=0)

    def boost(c, k=0.3):
        return np.clip(c + (c - c.mean()) * k, 0, 255)

    pal = {
        "furWhite":      boost(layered("white", 70, 95), 0.05),
        "furWhiteMid":   layered("white", 40, 62),
        "furWhiteShade": layered("white", 8, 25),
        "furOrange":     boost(layered("orange", 62, 92), 0.32),
        "furOrangeDeep": boost(layered("orange", 10, 30), 0.32),
        "furDark":       layered("dark", 5, 35),
        "furDarkSoft":   layered("dark", 60, 88),
        "eyeIris":       boost(layered("eye", 45, 80), 0.45),
    }
    pal["eyeHighlight"] = np.array([246, 248, 242])
    pal["nosePink"] = np.clip(pal["furWhiteMid"] * 1.0 + np.array([46, -34, -30]), 0, 255)
    pal["earPink"] = np.clip(pal["furWhiteMid"] + np.array([58, -26, -22]), 0, 255)
    pal["outline"] = np.clip(pal["furDark"] * 0.60, 0, 255)

    print("\n=== derived pixel palette ===")
    for k, v in pal.items():
        print(f"   {k:15s} {hexs(v)}")

    (OUT / "cat_palette.json").write_text(
        json.dumps(
            {
                "buckets": {k: hexs(np.median(np.concatenate(v, axis=0), axis=0)) for k, v in pools.items() if v},
                "pixel_palette": {k: {"hex": hexs(v), "rgb": [int(round(x)) for x in v]} for k, v in pal.items()},
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    # ---- mask check sheet -------------------------------------------------
    tw, th = 300, 300
    cols = 5
    grid = Image.new("RGB", (cols * tw, len(panels) * (th + 24)), (14, 14, 18))
    gd = ImageDraw.Draw(grid)
    for r, (name, tiles) in enumerate(panels):
        for c, (label, t) in enumerate(tiles):
            grid.paste(t, (c * tw, r * (th + 24) + 24))
            gd.text((c * tw + 6, r * (th + 24) + 6), f"{name[:10]} {label}", fill=(225, 225, 200))
    grid.save(OUT / "mask_check.png")

    # ---- palette band under the best photo --------------------------------
    src = Image.open(PHOTO / "1789017258615.jpg").convert("RGB")
    src = src.crop(CROPS["1789017258615.jpg"])
    src.thumbnail((1000, 1000))
    band_h = 132
    sheet = Image.new("RGB", (src.width, src.height + band_h), (18, 18, 22))
    sheet.paste(src, (0, 0))
    d = ImageDraw.Draw(sheet)
    x = 0
    for k, v in pal.items():
        c = tuple(int(round(q)) for q in v)
        d.rectangle([x, src.height, x + 108, src.height + band_h - 22], fill=c)
        ink = (16, 16, 16) if luma(np.array(c, float)) > 140 else (240, 240, 240)
        d.text((x + 5, src.height + 4), k[:14], fill=ink)
        d.text((x + 5, src.height + 18), hexs(v), fill=ink)
        x += 114
    sheet.save(OUT / "palette_swatches.png")
    print(f"\nwrote {OUT/'mask_check.png'}\nwrote {OUT/'palette_swatches.png'}")


if __name__ == "__main__":
    main()
