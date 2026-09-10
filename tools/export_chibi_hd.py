"""Export the high-density chibi into the shape the renderer / preview needs.

Frames are written per animation, plus a metadata file (frame counts, fps,
native size, anchor) that both the browser preview and the Electron renderer
consume -- one source of truth for animation timing.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from chibi_hd import Params, chibi  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "art" / "sprites" / "chibi-hd"
PREVIEW = ROOT / "preview"
PHOTO = ROOT / "Picture"

SCALE = 6

# name -> (label, fps, loop, [pose params])
ANIMS: dict[str, tuple[str, float, bool, list[Params]]] = {
    "sit": ("坐着待机", 2.2, True, [
        # `breath` no longer moves the art; the renderer scales the canvas a
        # little instead, so the pose stays put and only the tail sways
        Params(tail_swing=0.00),
        Params(tail_swing=0.35),
        Params(tail_swing=0.20),
        Params(tail_swing=-0.25),
    ]),
    "blink": ("眨眼", 8.0, True, [
        Params(), Params(blink=1), Params(blink=2), Params(blink=2),
        Params(blink=1), Params(),
    ]),
    "walk": ("走路", 7.0, True, [
        # A real gait cycle: neutral -> one leg forward -> neutral -> other leg
        # forward -> neutral. An earlier version ended on "leg forward" and
        # wrapped straight to "other leg forward", swapping both legs and
        # shifting the head within a single frame -- very visible juddering.
        # The tail lags the legs, so its swing stays a smooth sine across the
        # loop (0 -> 1.0 -> 0 -> -1.0 -> back to 0).
        Params(gait=0,  tail_swing=0.0,  look=0.0),
        Params(gait=1,  tail_swing=0.70, look=0.30),
        Params(gait=0,  tail_swing=1.00, look=0.12),
        Params(gait=0,  tail_swing=0.0,  look=0.0),
        Params(gait=-1, tail_swing=-0.70, look=-0.30),
        Params(gait=0,  tail_swing=-1.00, look=-0.12),
    ]),
    "sleep": ("打盹", 1.4, True, [
        Params(blink=2, squash=1, mood="sleepy", tail_swing=0.10),
        Params(blink=2, squash=2, mood="sleepy", tail_swing=0.00),
        Params(blink=2, squash=2, mood="sleepy", tail_swing=-0.10),
        Params(blink=2, squash=1, mood="sleepy", tail_swing=0.00),
    ]),
    "pat": ("被摸头", 3.2, False, [
        Params(blink=2, squash=2, tail_swing=0.3),
        Params(squash=1, blink=2, tail_swing=0.7),
        Params(look=0.8, tail_swing=1.0),
        Params(look=-0.8, tail_swing=0.6),
        Params(look=0.0, tail_swing=0.3),
    ]),
    "carry": ("被拎起后颈", 3.4, True, [
        # A cat held up by the scruff: `hang` hangs the body, drops the legs and
        # lets the tail fall, and `hang_sway` is a small pendulum that reads as
        # hanging rather than frozen.
        #
        # The sway follows a smooth arc and the blink is kept away from the turn,
        # because changing direction AND blinking on the same frame measured 18.4%
        # of the sprite -- the frame-difference guard rejected that as "not
        # breathing in place" and it looks like a jolt.
        Params(hang=1.0, dangle=1, blink=1, hang_sway=0.00, tail_swing=0.08),
        Params(hang=1.0, dangle=1, blink=0, hang_sway=0.10, tail_swing=0.22),
        Params(hang=1.0, dangle=1, blink=0, hang_sway=0.18, tail_swing=0.30),
        Params(hang=1.0, dangle=1, blink=0, hang_sway=0.04, tail_swing=0.10),
        Params(hang=1.0, dangle=1, blink=2, hang_sway=-0.12, tail_swing=-0.12),
        Params(hang=1.0, dangle=1, blink=0, hang_sway=-0.05, tail_swing=-0.04),
    ]),
    "angry": ("生气", 3.0, True, [
        Params(mood="angry", tail_swing=-0.6),
        Params(mood="angry", tail_swing=0.6),
    ]),
}


def export() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.png"):
        if stale.name.startswith("_") or stale.name == "walk_strip.png":
            continue          # keep dev/diagnostic images
        stale.unlink()

    base = chibi(Params())
    meta: dict = {
        "variant": "chibi-hd",
        "label": "三花猫 · 高密度像素",
        "native": [base.w, base.h],
        "scale": SCALE,
        "anims": {},
    }

    for key, (label, fps, loop, poses) in ANIMS.items():
        urls = []
        for i, p in enumerate(poses):
            canvas = chibi(p)
            name = f"{key}_{i}.png"
            Image.fromarray(canvas.to_array(SCALE), mode="RGBA").save(OUT / name)
            Image.fromarray(canvas.to_array(1), mode="RGBA").save(OUT / f"{key}_{i}@1x.png")
            urls.append(f"frames/{key}_{i}.png")
        meta["anims"][key] = {
            "label": label, "fps": fps, "loop": loop,
            "count": len(poses), "frames": urls,
        }
        print(f"  {key:6s} {len(poses)} frames @ {fps}fps  ({label})")

    (OUT / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    # frame dir the preview page reads
    fdir = PREVIEW / "frames"
    if fdir.exists():
        shutil.rmtree(fdir)
    fdir.mkdir(parents=True, exist_ok=True)
    for png in OUT.glob("*.png"):
        if "@1x" in png.name or png.name in ("sheet.png", "walk_strip.png"):
            continue
        shutil.copy2(png, fdir / png.name)
    return meta


def photos() -> list[str]:
    out = PREVIEW / "photos"
    out.mkdir(parents=True, exist_ok=True)
    names = []
    for p in sorted(PHOTO.glob("*.jpg")):
        im = Image.open(p).convert("RGB")
        im.thumbnail((520, 520), Image.LANCZOS)
        dst = out / (p.stem + ".jpg")
        im.save(dst, quality=84, optimize=True)
        names.append(dst.name)
    return names


def main() -> None:
    PREVIEW.mkdir(parents=True, exist_ok=True)
    print("exporting chibi-hd...")
    meta = export()
    photos()
    (PREVIEW / "pet.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    total = sum(v["count"] for v in meta["anims"].values())
    print(f"done: {total} frames, native {meta['native'][0]}x{meta['native'][1]}")


if __name__ == "__main__":
    main()
