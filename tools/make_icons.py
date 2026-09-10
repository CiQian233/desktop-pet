"""Generate the app/tray icons from the cat's own pixel palette.

Writes:
  build/icon.png    256x256 app icon
  build/icon.ico    multi-size ICO (PNG-compressed entries, Vista+)
  assets/tray.png   32x32 tray icon
  assets/tray@2x.png

The head is drawn from an ASCII pixel map so it stays readable at 16x16 --
scaling the full-body sprite down that far just turns into mush.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from palette import PALETTE  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
ASSETS = ROOT / "assets"

# 16x16 cat head, calico: ginger left ear, ink right side, white blaze + muzzle
HEAD = r"""
................
.....oo....kk...
....oOo...kKk...
...oOOo..kKKk...
..oooooooooooo..
..oOOOOOOOOOOk..
.oOOWWWWWWWOOko.
.oOWWWWWWWWWWko.
.oWWkkWWWkkWWWo.
.oWWkAkWkAkWWWo.
.oWWkkWWWkkWWWo.
.oWWWWWPWWWWWWo.
.oWWWWPPPWWWWWo.
..oWWWWWWWWWWo..
...ooooooooo....
................
""".strip("\n").splitlines()

LEGEND = {
    ".": None,
    "o": (158, 100, 48),
    "O": (191, 131, 66),
    "k": (38, 32, 26),
    "K": (58, 49, 40),
    "W": (243, 239, 232),
    "A": (178, 118, 44),
    "P": (214, 146, 142),
    "L": (30, 25, 21),
}


def render_head(scale: int) -> Image.Image:
    rows = len(HEAD)
    cols = max(len(r) for r in HEAD)
    img = Image.new("RGBA", (cols, rows), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(HEAD):
        for x, ch in enumerate(row):
            rgb = LEGEND.get(ch)
            if rgb:
                px[x, y] = (*rgb, 255)
    img = img.resize((cols * scale, rows * scale), Image.NEAREST)
    # outline pass: 1 source pixel of dark rim around the silhouette
    return img


def with_outline(img: Image.Image, block: int, colour=(30, 25, 21, 255)) -> Image.Image:
    """Add a block-wide dark rim outside the silhouette."""
    w, h = img.size
    src = img.load()
    out = Image.new("RGBA", (w + block * 2, h + block * 2), (0, 0, 0, 0))
    dst = out.load()
    for y in range(h + block * 2):
        for x in range(w + block * 2):
            sx, sy = x - block, y - block
            a = src[sx, sy][3] if 0 <= sx < w and 0 <= sy < h else 0
            if a:
                dst[x, y] = src[sx, sy]
                continue
            near = False
            for dy in range(-block, block + 1):
                for dx in range(-block, block + 1):
                    nx, ny = sx + dx, sy + dy
                    if 0 <= nx < w and 0 <= ny < h and src[nx, ny][3]:
                        near = True
                        break
                if near:
                    break
            if near:
                dst[x, y] = colour
    return out


def write_ico(path: Path, images: list[Image.Image]) -> None:
    """Minimal ICO writer: PNG-compressed entries (supported since Vista)."""
    import io

    blobs = []
    for im in images:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        blobs.append(buf.getvalue())

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, data = b"", b""
    for im, blob in zip(images, blobs):
        w = 0 if im.width >= 256 else im.width
        h = 0 if im.height >= 256 else im.height
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        data += blob
    path.write_bytes(header + entries + data)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    base = with_outline(render_head(16), 16)          # 16px map -> 288px w/ rim
    icon = base.resize((256, 256), Image.NEAREST)
    icon.save(BUILD / "icon.png")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    write_ico(BUILD / "icon.ico", [base.resize((s, s), Image.NEAREST) for s in sizes])

    tray = with_outline(render_head(2), 2)
    tray.resize((32, 32), Image.LANCZOS).save(ASSETS / "tray.png")
    tray.resize((64, 64), Image.LANCZOS).save(ASSETS / "tray@2x.png")

    print(f"  build/icon.png   256x256")
    print(f"  build/icon.ico   {len(sizes)} sizes")
    print(f"  assets/tray.png  32x32")
    # palette keys actually used, as a sanity check
    used = {c for row in HEAD for c in row if c != "."}
    print(f"  colours used: {sorted(used)} of {len(PALETTE)} available")


if __name__ == "__main__":
    main()
