"""Export preview data for the picking page: frame PNGs, a JS manifest and
downscaled copies of the reference photos.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_sprites as rs  # noqa: E402  (needs the tools dir on sys.path)

ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / "art" / "sprites"
PREVIEW = ROOT / "preview"
PHOTO = ROOT / "Picture"

SCALE = 6

# animation name -> list of keyword-arg dicts, replayed on a timer
ANIMS: dict[str, dict] = {
    "sit": {"label": "待机 · 坐着", "fps": 2.0, "loop": True,
            "frames": [{}, {"breath": 1}]},
    "blink": {"label": "眨眼", "fps": 7.0, "loop": True,
              "frames": [{}, {}, {}, {"blink": True}, {"blink": True}, {}, {}, {}]},
    "walk": {"label": "走路", "fps": 6.0, "loop": True,
             "frames": [{"gait": 1, "tail_lift": -1, "look": 0.6},
                        {"breath": 1, "gait": 0, "look": 0.2},
                        {"gait": -1, "tail_lift": -1, "look": -0.6},
                        {"breath": 1, "gait": 0, "look": -0.2}]},
    "plead": {"label": "被戳 · 求摸", "fps": 3.0, "loop": False,
              "frames": [{"squash": 2, "blink": True, "look": 0.0},
                         {"squash": 0, "look": -0.8},
                         {"breath": 1, "look": 0.8},
                         {"look": 0.0}]},
    "sleep": {"label": "睡着", "fps": 1.3, "loop": True,
              "frames": [{"squash": 1, "blink": True, "tail_lift": -1},
                         {"squash": 2, "blink": True, "tail_lift": -2},
                         {"squash": 1, "blink": True, "tail_lift": -1}]},
}


def export_frames() -> dict:
    data: dict = {"scale": SCALE, "variants": {}, "anims": {}}
    for key, spec in ANIMS.items():
        data["anims"][key] = {"label": spec["label"], "fps": spec["fps"],
                              "loop": spec["loop"], "count": len(spec["frames"])}

    for name, (fn, label) in rs.VARIANTS.items():
        outdir = PREVIEW / "frames" / name
        if outdir.exists():
            shutil.rmtree(outdir)
        outdir.mkdir(parents=True, exist_ok=True)
        base = fn()
        entries = {}
        for anim, spec in ANIMS.items():
            urls = []
            for i, kw in enumerate(spec["frames"]):
                canvas = fn(**kw)
                path = outdir / f"{anim}_{i}.png"
                rs.write_png(canvas, path, scale=SCALE)
                urls.append(f"frames/{name}/{path.name}")
            entries[anim] = urls
        data["variants"][name] = {
            "label": label,
            "native": [base.w, base.h],
            "anims": entries,
        }
        print(f"  {name}: {sum(len(v) for v in entries.values())} frames")

    (PREVIEW / "sprites.js").write_text(
        "window.SPRITES = " + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8"
    )
    return data


def export_photos() -> list[str]:
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
    print("exporting frames...")
    export_frames()
    photos = export_photos()
    print(f"exported {len(photos)} photos")


if __name__ == "__main__":
    main()
