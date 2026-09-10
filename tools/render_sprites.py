"""Generate pixel-art cat sprite sheets from the photo-derived palette.

All variants share one set of part builders (ears / eyes / muzzle / fur marks)
parameterised by head geometry, so the proportions stay authored in one place
and every pose is a function of a few deform parameters (breath, blink, tail
lift, squash). Adding an animation = adding a call.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

from pixel import Canvas

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "art" / "sprites"


# --------------------------------------------------------------------------
# parts
# --------------------------------------------------------------------------


def ears(c: Canvas, hx: float, hy: float, hrx: float, hry: float,
         left_fur: str = "K", right_fur: str = "O", size: float = 1.0) -> None:
    for sgn, fur in ((-1, left_fur), (1, right_fur)):
        bx = hx + sgn * hrx * 0.58
        tipx = hx + sgn * (hrx * 0.58 + 3.2 * size)
        base_y = hy - hry * 0.60
        c.triangle([(bx, base_y + 2.8 * size),
                    (tipx, base_y - 4.2 * size),
                    (hx + sgn * hrx * 0.20, base_y - 0.4 * size)], fur)
        c.triangle([(bx + sgn * 0.9, base_y + 1.8 * size),
                    (tipx - sgn * 1.4, base_y - 1.6 * size),
                    (hx + sgn * hrx * 0.34, base_y + 0.7 * size)], "p")


def eye(c: Canvas, cx: float, cy: float, *, rx: float, ry: float, blink: bool,
        look: float) -> None:
    """Cat eye: dark almond rim, green iris, vertical pupil, white sparkle.

    Drawn so that no white ever escapes above the rim -- the classic failure
    that makes pixel eyes look like they are floating off the face.
    """
    if blink:
        c.ellipse(cx, cy, rx + 0.3, ry * 0.75, "k")           # closed lid
        c.arc(cx, cy - ry * 0.35, rx + 0.2, 1.0, "w3", a0=200, a1=340)
        return
    c.ellipse(cx, cy, rx, ry, "k")                             # rim / lash
    c.ellipse(cx, cy + ry * 0.16, rx - 1.05, ry - 0.95, "E")   # iris
    c.ellipse(cx, cy + ry * 0.55, rx - 1.05, ry - 1.45, "D",
              overwrite=True)                                  # iris shadow
    c.ellipse(cx, cy - ry * 0.30, rx - 1.35, ry - 1.35, "E",
              overwrite=True)                                  # iris light
    c.ellipse(cx + look * 0.6, cy + 0.2, max(0.7, rx * 0.32), ry - 1.3, "i")  # pupil
    c.put(int(round(cx - rx * 0.62)), int(round(cy - ry * 0.55)), "H")        # sparkle


def eyes(c: Canvas, hx: float, hy: float, hrx: float, *, dy: float,
         rx: float, ry: float, blink: bool, look: float, gap: float = 0.42) -> None:
    for sgn in (-1, 1):
        eye(c, hx + sgn * hrx * gap, hy + dy, rx=rx, ry=ry, blink=blink, look=look * sgn)


def nose_mouth(c: Canvas, hx: float, ny: float, hrx: float) -> None:
    c.triangle([(hx - 1.6, ny - 1.6), (hx + 1.6, ny - 1.6), (hx, ny + 0.6)], "P")
    c.put(int(hx - 0.5), int(ny), "p")
    c.put(int(hx), int(ny + 1), "S")
    c.put(int(hx - 1), int(ny + 2), "S")
    c.put(int(hx + 1), int(ny + 2), "S")


def whiskers(c: Canvas, hx: float, ny: float, hrx: float, reach: int = 3) -> None:
    for sgn in (-1, 1):
        wx = int(hx + sgn * hrx * 0.52)
        for dy in (0, 2):
            for step in range(reach):
                c.put(wx + sgn * (step + 1), int(ny) + dy, "w3")


def face_marks(c: Canvas, hx: float, hy: float, hrx: float, hry: float) -> None:
    """Calico cap.

    Painted as *regions* rather than round spots: ginger over the left temple,
    ink over the right brow and the cheek under the right eye, then the white
    blaze + muzzle are brushed back in the centre. Painting in that order is
    what keeps the face readable and the nose bridge clean.
    """
    nx, ny = (np.arange(c.w) + 0.5 - hx) / hrx, (np.arange(c.h) + 0.5 - hy) / hry
    X, Y = np.meshgrid(nx, ny)

    ginger = ((X < -0.18) & (Y < 0.02)) | ((X < 0.22) & (Y < -0.52))
    ink = ((X > 0.20) & (Y < -0.06)) | ((X > 0.42) & (Y > 0.12))
    blaze = (np.abs(X) < 0.17) & (Y < 0.48)

    c.repaint_inside(ink & ~blaze, "K", only="W")
    c.repaint_inside(ginger & ~blaze & ~ink, "O", only="W")
    c.repaint_inside(blaze, "W")
    c.ellipse(hx - hrx * 0.06, hy + hry * 0.46, hrx * 0.72, hry * 0.52, "W")


def bib(c: Canvas, cx: float, cy: float, rx: float, ry: float, *, shadow: bool = True) -> None:
    if shadow:
        c.ellipse(cx - 0.6, cy + 0.6, rx + 0.7, ry + 0.6, "w2")
    c.ellipse(cx, cy, rx, ry, "W")


# --------------------------------------------------------------------------
# variant A -- chibi
# --------------------------------------------------------------------------


def variant_chibi(breath: int = 0, blink: bool = False, look: float = 0.0,
                  tail_lift: int = 0, squash: int = 0, gait: int = 0) -> Canvas:
    c = Canvas(44, 42)
    d = breath - squash - abs(gait) * 0.6
    hx, hy = 17.0 + gait * 0.4, 14.0 + d * 0.5
    hrx, hry = 10.4, 9.0

    ty = 34.0 + tail_lift
    c.arc(30.0, ty - 3.6, 6.2, 3.1, "k", a0=250, a1=110)
    c.arc(30.0, ty - 3.6, 6.2, 3.1, "O", a0=52, a1=94)
    c.arc(30.0, ty - 3.6, 6.2, 3.1, "K", a0=22, a1=48)

    c.blob([
        (25.5, 30.5 + d, 8.4, 8.2 + breath * 0.45),
        (18.5, 31.0 + d, 7.8, 7.8 + breath * 0.45),
        (20.0, 25.5 + d, 8.4, 7.0),
    ], "w")
    c.spots([(25.0, 26.5 + d, 7.4), (21.5, 23.5 + d, 5.6)], "o", only="w")
    c.spots([(27.5, 22.5 + d, 5.0)], "k", only="w")
    c.arc(25.5, 32.0 + d, 7.4, 1.0, "w2", a0=30, a1=150)

    # head first, then ears behind it, so ears read as attached
    ears(c, hx, hy, hrx, hry, left_fur="O", right_fur="K", size=1.0)
    c.ellipse(hx, hy, hrx, hry, "W")
    c.spots([(hx + hrx * 0.62, hy - hry * 0.66, hrx * 0.52)], "K", only="W")
    face_marks(c, hx, hy, hrx, hry)

    eyes(c, hx, hy, hrx, dy=-hry * 0.26 + d * 0.5, rx=2.6, ry=2.3,
         blink=blink, look=look, gap=0.40)
    nose_mouth(c, hx, hy + hry * 0.20 + d * 0.5, hrx)
    whiskers(c, hx, hy + hry * 0.22 + d * 0.5, hrx, reach=3)

    for i, (px, py, r) in enumerate(((13.5, 36.2 + d, 2.7), (19.5, 36.5 + d, 2.9))):
        step = gait * (1 if i == 0 else -1)
        px, py = px + step, py - max(0, step)
        c.ellipse(px, py, r, r * 0.76, "w2")
        c.ellipse(px, py - 0.4, r - 0.5, r * 0.70, "W")
        for t in (-1, 0, 1):
            c.put(int(px + t * 1.1), int(py - 0.2), "w2")

    bib(c, 16.0, 32.5 + d, 5.4, 5.0)
    c.outline("L")
    return c


# --------------------------------------------------------------------------
# variant B -- realistic proportions
# --------------------------------------------------------------------------


def variant_real(breath: int = 0, blink: bool = False, look: float = 0.0,
                 tail_lift: int = 0, squash: int = 0, gait: int = 0) -> Canvas:
    c = Canvas(52, 50)
    d = breath - squash - abs(gait) * 0.6
    hx, hy = 16.0 + gait * 0.4, 12.0 + d * 0.5
    hrx, hry = 8.6, 7.6

    ty = 38.0 + tail_lift
    c.arc(33.0, ty - 4.2, 6.8, 2.9, "k", a0=255, a1=105)
    c.arc(33.0, ty - 4.2, 6.8, 2.9, "O", a0=52, a1=92)
    c.arc(33.0, ty - 4.2, 6.8, 2.9, "K", a0=22, a1=48)

    c.blob([
        (29.5, 32.0 + d, 9.0, 8.6 + breath * 0.4),
        (24.0, 33.0 + d, 8.6, 8.2 + breath * 0.4),
        (17.5, 27.0 + d, 6.8, 9.0),
    ], "w")
    c.spots([(29.0, 26.0 + d, 8.0), (32.0, 32.0 + d, 5.4)], "o", only="w")
    c.spots([(23.5, 22.5 + d, 5.4), (34.0, 24.0 + d, 4.6)], "k", only="w")
    c.arc(29.5, 34.0 + d, 7.8, 1.0, "w2", a0=35, a1=150)

    ears(c, hx, hy, hrx, hry, left_fur="K", right_fur="O", size=1.05)
    c.ellipse(hx, hy, hrx, hry, "W")
    face_marks(c, hx, hy, hrx, hry)

    eyes(c, hx, hy, hrx, dy=-hry * 0.22 + d * 0.5, rx=2.3, ry=2.0,
         blink=blink, look=look, gap=0.44)
    nose_mouth(c, hx, hy + hry * 0.22 + d * 0.5, hrx)
    whiskers(c, hx, hy + hry * 0.24 + d * 0.5, hrx, reach=4)

    # front legs down to tucked paws; they alternate during a walk
    for i, lx in enumerate((13.2, 18.6)):
        step = gait * (1 if i == 0 else -1)
        lx += step
        bot = 42 + d - max(0, step)
        top = 30 + d
        c.rect(int(lx - 1.8), int(top), int(lx + 1.8), int(bot), "w2")
        c.rect(int(lx - 1.3), int(top), int(lx + 1.3), int(bot), "W")
        c.arc(lx, bot - 0.5, 2.1, 1.0, "w2", a0=10, a1=170)
        c.put(int(lx - 1), int(bot - 1.5), "w2")
        c.put(int(lx + 1), int(bot - 1.5), "w2")

    bib(c, 16.0, 33.0 + d, 5.0, 6.4)
    c.outline("L")
    return c


# --------------------------------------------------------------------------
# variant C -- retro 32px grid
# --------------------------------------------------------------------------


def variant_retro(breath: int = 0, blink: bool = False, look: float = 0.0,
                  tail_lift: int = 0, squash: int = 0, gait: int = 0) -> Canvas:
    c = Canvas(34, 34)
    d = breath - squash - abs(gait) * 0.5
    hx, hy = 13.0 + gait * 0.3, 11.5 + d * 0.5
    hrx, hry = 7.8, 7.0

    ty = 26.5 + tail_lift
    c.arc(22.5, ty - 3.0, 5.0, 2.4, "k", a0=255, a1=105)
    c.arc(22.5, ty - 3.0, 5.0, 2.4, "O", a0=52, a1=90)

    c.blob([
        (20.0, 23.0 + d, 6.6, 6.2 + breath * 0.4),
        (15.5, 24.0 + d, 6.0, 5.8 + breath * 0.4),
    ], "w")
    c.spots([(20.0, 19.5 + d, 5.4)], "o", only="w")
    c.spots([(22.5, 17.0 + d, 3.8)], "k", only="w")

    ears(c, hx, hy, hrx, hry, left_fur="K", right_fur="O", size=0.9)
    c.ellipse(hx, hy, hrx, hry, "W")
    c.spots([(hx + hrx * 0.64, hy - hry * 0.62, hrx * 0.48)], "K", only="W")
    face_marks(c, hx, hy, hrx, hry)

    eyes(c, hx, hy, hrx, dy=-hry * 0.20 + d * 0.5, rx=2.0, ry=1.8,
         blink=blink, look=look, gap=0.44)
    nose_mouth(c, hx, hy + hry * 0.24 + d * 0.5, hrx)
    whiskers(c, hx, hy + hry * 0.26 + d * 0.5, hrx, reach=3)

    for i, (px, py) in enumerate(((11.0, 28.5 + d), (16.0, 28.8 + d))):
        step = gait * (1 if i == 0 else -1)
        px, py = px + step, py - max(0, step)
        c.ellipse(px, py, 2.3, 1.8, "w2")
        c.ellipse(px, py - 0.3, 1.9, 1.5, "W")

    bib(c, 12.5, 25.5 + d, 4.2, 4.0)
    c.outline("L")
    return c


VARIANTS = {
    "chibi": (variant_chibi, "大头圆身 · 呆萌"),
    "real": (variant_real, "照片比例 · 写实"),
    "retro": (variant_retro, "32×32 · 复古"),
}


def write_png(c: Canvas, path: Path, scale: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(c.to_array(scale), mode="RGBA").save(path)


def build_frames(fn) -> dict[str, "Canvas"]:
    return {
        "idle_0": fn(),
        "idle_1": fn(breath=1),
        "blink_0": fn(blink=True),
        "walk_0": fn(tail_lift=-1, gait=1, look=0.5),
        "walk_1": fn(breath=1, tail_lift=-1, gait=-1, look=-0.5),
        "squash": fn(squash=2),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, object] = {"variants": {}}

    for name, (fn, label) in VARIANTS.items():
        frames = build_frames(fn)
        base = frames["idle_0"]
        d = OUT / name
        if d.exists():
            for stale in d.glob("*.png"):
                stale.unlink()
        for fname, canvas in frames.items():
            write_png(canvas, d / f"{fname}.png")
            write_png(canvas, d / f"{fname}@8x.png", scale=8)
        manifest["variants"][name] = {
            "label": label, "size": [base.w, base.h], "frames": list(frames),
        }
        print(f"\n===== {name} ({label}) {base.w}x{base.h} =====")
        for row in base.to_rows():
            print("   " + row.replace(".", " "))

    (OUT / "sprites.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    tiles = []
    for name in VARIANTS:
        for frame in ("idle_0", "idle_1", "blink", "squash"):
            tiles.append(Image.open(OUT / name / f"{frame}@8x.png"))
    cw = max(t.width for t in tiles) + 24
    ch = max(t.height for t in tiles) + 24
    cols = 4
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cw, rows * ch), (30, 32, 40, 255))
    for i, t in enumerate(tiles):
        x = (i % cols) * cw + (cw - t.width) // 2
        y = (i // cols) * ch + (ch - t.height) // 2
        sheet.alpha_composite(t, (x, y))
    sheet.convert("RGB").save(OUT / "contact_sheet.png")
    print(f"\nwrote {OUT/'contact_sheet.png'}")


if __name__ == "__main__":
    main()
