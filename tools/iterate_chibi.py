"""Visual iteration harness for the high-density chibi (dev only).

Run `python tools/iterate_chibi.py [scale]` to dump every pose plus a
no-outline debug frame into art/sprites/chibi-hd/. The production export lives
in tools/export_chibi_hd.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from chibi_hd import Params, chibi  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "art" / "sprites" / "chibi-hd"

POSES = {
    "idle_0": Params(),
    "idle_1": Params(breath=1, tail_swing=0.35),
    "blink": Params(blink=2),
    "walk_a": Params(gait=1, tail_swing=1.0, look=0.6),
    "walk_b": Params(breath=1, gait=0, tail_swing=0.0),
    "walk_c": Params(gait=-1, tail_swing=-1.0, look=-0.6),
    "sleepy": Params(blink=2, squash=2, mood="sleepy"),
    "angry": Params(mood="angry"),
    "dangle": Params(dangle=1, blink=1, tail_swing=0.6),
    "raw": Params(debug=True),
}


def main() -> None:
    scale = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    OUT.mkdir(parents=True, exist_ok=True)
    tiles = []
    for name, p in POSES.items():
        img = Image.fromarray(chibi(p).to_array(scale), mode="RGBA")
        img.save(OUT / f"_dev_{name}.png")
        tiles.append(img)
        print(f"  {name:8s} {img.width}x{img.height}")

    cw = max(t.width for t in tiles) + 16
    ch = max(t.height for t in tiles) + 16
    cols = 5
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cw, rows * ch), (32, 34, 42, 255))
    for i, t in enumerate(tiles):
        sheet.alpha_composite(t, ((i % cols) * cw + (cw - t.width) // 2,
                                  (i // cols) * ch + (ch - t.height) // 2))
    sheet.convert("RGB").save(OUT / "_dev_sheet.png")
    print(f"wrote {OUT/'_dev_sheet.png'}")


if __name__ == "__main__":
    main()
