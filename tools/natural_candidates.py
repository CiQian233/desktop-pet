"""Generate A/B/C natural-action previews without changing the live sprite set.

A is the current v0.4.0 action. B and C are selection candidates only. All art
uses the original 76 x 68 raster and palette; output is limited to preview/.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from chibi_hd import Params, chibi  # noqa: E402
from natural_frames import NATURAL_ANIMS  # noqa: E402
from palette import EMPTY, PALETTE  # noqa: E402
from pixel import Canvas  # noqa: E402

W, H = 76, 68
OUT = ROOT / "preview" / "natural-candidates-v040"
RGBA_TO_CHAR = {(*rgb, 255): ch for ch, rgb in PALETTE.items()}


def finish(c: Canvas) -> Canvas:
    c.unify_outer_outline()
    return c


def transform(source: Canvas, sx: float = 1.0, sy: float = 1.0,
              angle: float = 0.0, dx: int = 0, dy: int = 0) -> Canvas:
    """Nearest-neighbour scale/rotate, centred and anchored to the ground."""
    image = Image.fromarray(source.to_array(1), "RGBA")
    box = image.getchannel("A").getbbox()
    if not box:
        return Canvas(W, H)
    image = image.crop(box)
    nw = max(1, round(image.width * sx))
    nh = max(1, round(image.height * sy))
    image = image.resize((nw, nh), Image.Resampling.NEAREST)
    if angle:
        image = image.rotate(angle, Image.Resampling.NEAREST, expand=True)
    factor = min(1.0, (W - 4) / image.width, (H - 4) / image.height)
    if factor < 1.0:
        image = image.resize((max(1, round(image.width * factor)),
                              max(1, round(image.height * factor))),
                             Image.Resampling.NEAREST)
    out = Canvas(W, H)
    ox = (W - image.width) // 2 + dx
    oy = H - 3 - image.height + dy
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            rgba = pixels[x, y]
            if rgba[3]:
                out.put(ox + x, oy + y, RGBA_TO_CHAR.get(tuple(rgba), EMPTY))
    return finish(out)


def tongue(source: Canvas, side: int = -1, length: int = 2) -> Canvas:
    c = Canvas(W, H)
    c.grid = [list(row) for row in source.grid]
    x = 35 + side * 5
    for i in range(length):
        c.put(x, 33 + i, "P")
        if i == length - 1:
            c.put(x + side, 33 + i, "P")
    return finish(c)


def washing_paw(source: Canvas, dx: int = 0, dy: int = 0) -> Canvas:
    c = Canvas(W, H)
    c.grid = [list(row) for row in source.grid]
    c.ellipse(26 + dx, 43 + dy, 4.2, 8.0, "w2")
    c.ellipse(28 + dx, 36 + dy, 4.6, 3.8, "W")
    c.put(26 + dx, 36 + dy, "w2")
    c.put(29 + dx, 37 + dy, "w2")
    return finish(c)


def raised_paw(source: Canvas, dx: int = 0, dy: int = 0) -> Canvas:
    c = Canvas(W, H)
    c.grid = [list(row) for row in source.grid]
    c.ellipse(47 + dx, 42 + dy, 4.0, 10.0, "w")
    c.ellipse(49 + dx, 31 + dy, 4.4, 5.0, "W")
    c.put(47 + dx, 28 + dy, "w2")
    c.put(50 + dx, 28 + dy, "w2")
    c.put(52 + dx, 31 + dy, "w2")
    return finish(c)


def marks(source: Canvas, kind: str = "scratch") -> Canvas:
    """Cosmetic motion/shadow marks, added after the outer-outline pass."""
    c = Canvas(W, H)
    c.grid = [list(row) for row in source.grid]
    if kind == "scratch":
        for x, y in ((17, 58), (15, 61), (19, 63), (14, 65)):
            c.put(x, y, "S")
            c.put(x + 1, y, "S")
    elif kind == "wave":
        for x, y in ((57, 24), (60, 27), (58, 31)):
            c.put(x, y, "S")
            c.put(x + 1, y - 1, "S")
    elif kind == "shadow":
        c.ellipse(36, 66, 15, 1.2, "S")
    return c


def normalize(frames: list[Canvas], count: int = 8) -> list[Canvas]:
    if len(frames) == count:
        return frames
    return [frames[round(i * (len(frames) - 1) / (count - 1))] for i in range(count)]


def candidates() -> dict[str, dict]:
    sit = chibi(Params())
    stand = chibi(Params(gait=1, look=0.3))
    sleepy = chibi(Params(squash=2, blink=2, mood="sleepy"))
    result: dict[str, dict] = {}

    result["stretch"] = {
        "title": "伸懒腰", "names": ["A · 向上舒展（当前）", "B · 弓背伸展", "C · 低位前伸"],
        "variants": [
            normalize(NATURAL_ANIMS["stretch"][3]),
            [sit, transform(stand, .98, .96), transform(stand, .94, 1.02, -5),
             transform(stand, .92, 1.07, -10, dx=-1), transform(stand, .94, 1.04, 6, dx=1),
             transform(stand, .97, .99), chibi(Params(blink=1)), sit],
            [sit, transform(stand, 1.02, .92, -4), transform(stand, 1.10, .82, -7, dx=-1),
             transform(stand, 1.18, .72, -10, dx=-2), transform(stand, 1.16, .74, -8, dx=-1),
             transform(stand, 1.08, .84, -4), chibi(Params(squash=1, blink=1)), sit],
        ], "peak": 3,
    }

    groom_base = [chibi(Params(gait=1, look=-1, blink=b, squash=s))
                  for b, s in ((1, 1), (2, 1), (2, 2), (2, 2), (1, 1), (2, 1))]
    result["groom"] = {
        "title": "舔毛", "names": ["A · 侧头舔毛（当前）", "B · 伸舌慢舔", "C · 抬爪洗脸"],
        "variants": [
            normalize(NATURAL_ANIMS["groom"][3]),
            [sit, transform(groom_base[0], 1, 1, -3),
             transform(tongue(groom_base[1], -1, 1), 1, 1, -5),
             transform(tongue(groom_base[2], -1, 3), 1, 1, -7),
             transform(tongue(groom_base[3], -1, 2), 1, 1, -5),
             transform(tongue(groom_base[4], -1, 1), 1, 1, -3),
             transform(groom_base[5], 1, 1, -2), sit],
            [sit, washing_paw(chibi(Params(blink=1, squash=1)), -1, 3),
             washing_paw(chibi(Params(blink=2, squash=1)), 0, 0),
             tongue(washing_paw(chibi(Params(blink=2, squash=1)), 1, -2), -1, 2),
             washing_paw(chibi(Params(blink=2, squash=1)), -1, 1),
             tongue(washing_paw(chibi(Params(blink=1, squash=1)), 1, -1), -1, 1),
             washing_paw(chibi(Params(blink=2, squash=1)), 0, 2), sit],
        ], "peak": 3,
    }

    result["scratch"] = {
        "title": "磨爪", "names": ["A · 交替磨爪（当前）", "B · 俯身快磨", "C · 单边慢磨"],
        "variants": [
            normalize(NATURAL_ANIMS["scratch"][3]),
            [sit, chibi(Params(gait=1, look=.7, squash=1)),
             marks(chibi(Params(gait=-1, look=.7, squash=2))),
             marks(chibi(Params(gait=1, look=.8, squash=1))),
             marks(chibi(Params(gait=-1, look=.7, squash=2))),
             marks(chibi(Params(gait=1, look=.8, squash=1))),
             chibi(Params(gait=-1, look=.5, squash=1)), sit],
            [sit, chibi(Params(gait=0, look=.5)),
             marks(chibi(Params(gait=1, look=.6, squash=1))),
             chibi(Params(gait=0, look=.5, blink=1)),
             marks(chibi(Params(gait=1, look=.6, squash=1))),
             chibi(Params(gait=0, look=.5)),
             chibi(Params(gait=1, look=.4, blink=1)), sit],
        ], "peak": 3,
    }

    result["lieDown"] = {
        "title": "趴下", "names": ["A · 缓缓趴下（当前）", "B · 匍匐趴下", "C · 侧卧蜷眠"],
        "variants": [
            normalize(NATURAL_ANIMS["lieDown"][3]),
            [sit, transform(chibi(Params(gait=-1, squash=1, blink=1)), 1.02, .94),
             transform(chibi(Params(gait=-1, squash=2, blink=1)), 1.10, .82, dx=-1),
             transform(chibi(Params(gait=-1, squash=2, blink=2, mood="sleepy")), 1.18, .70, dx=-2),
             transform(sleepy, 1.22, .66, dx=-2), transform(sleepy, 1.20, .68, dx=-1),
             transform(sleepy, 1.16, .72), transform(sleepy, 1.12, .76)],
            [sit, transform(chibi(Params(squash=1, blink=1)), 1.02, .94, -12),
             transform(sleepy, 1.00, .90, -35), transform(sleepy, .94, .92, -58),
             transform(sleepy, .90, .94, -72), transform(sleepy, .90, .94, -76),
             transform(sleepy, .92, .94, -72), transform(sleepy, .92, .94, -72)],
        ], "peak": 4,
    }

    upside = transform(sleepy, .90, .90, 180)
    result["roll"] = {
        "title": "翻肚", "names": ["A · 仰卧翻肚（当前）", "B · 左右摇肚", "C · 原地侧滚"],
        "variants": [
            normalize(NATURAL_ANIMS["roll"][3]),
            [sit, transform(sleepy, 1.04, .86), transform(upside, 1, 1, -14),
             transform(upside, 1, 1, 12), transform(upside, 1, 1, -10),
             transform(upside, 1, 1, 8), transform(sleepy, 1.04, .86), sit],
            [sit, transform(sleepy, .94, .94, -35), transform(sleepy, .88, .88, -75),
             transform(sleepy, .84, .84, -115), transform(sleepy, .86, .86, -160),
             transform(sleepy, .84, .84, -205), transform(sleepy, .90, .90, -300), sit],
        ], "peak": 3,
    }

    result["greet"] = {
        "title": "启动迎接", "names": ["A · 摇尾迎接（当前）", "B · 举爪打招呼", "C · 轻跳迎接"],
        "variants": [
            normalize(NATURAL_ANIMS["greet"][3]),
            [sit, raised_paw(chibi(Params(look=.5, tail_swing=.4)), -1, 3),
             marks(raised_paw(chibi(Params(look=.7, blink=1, tail_swing=.8)), 0, 0), "wave"),
             marks(raised_paw(chibi(Params(look=.7, blink=2, tail_swing=1)), 3, -3), "wave"),
             marks(raised_paw(chibi(Params(look=.7, tail_swing=.8)), 0, 0), "wave"),
             raised_paw(chibi(Params(look=.5, blink=1, tail_swing=.5)), 2, -2),
             raised_paw(chibi(Params(look=.3, tail_swing=.3)), -1, 3), sit],
            [sit, chibi(Params(squash=1, blink=1, tail_swing=.3)),
             transform(chibi(Params(blink=2, tail_swing=.8)), 1, 1, dy=-2),
             marks(transform(chibi(Params(blink=2, look=.4, tail_swing=1)), 1, 1, dy=-6), "shadow"),
             marks(transform(chibi(Params(blink=2, look=-.3, tail_swing=.7)), 1, 1, dy=-4), "shadow"),
             transform(chibi(Params(blink=1, tail_swing=.4)), 1, 1, dy=-1),
             chibi(Params(squash=1, tail_swing=.2)), sit],
        ], "peak": 3,
    }

    result["wakeUp"] = {
        "title": "睡醒叫醒", "names": ["A · 睁眼叫醒（当前）", "B · 伸腰苏醒", "C · 迷糊回神"],
        "variants": [
            normalize(NATURAL_ANIMS["wakeUp"][3]),
            [sleepy, chibi(Params(blink=1, squash=2, mood="sleepy")),
             chibi(Params(blink=1, squash=1)), chibi(Params(blink=0)),
             transform(stand, .97, 1.00), transform(stand, .94, 1.06, -4),
             transform(stand, .97, 1.01), sit],
            [sleepy, transform(chibi(Params(blink=1, squash=2, mood="sleepy")), 1, 1, -5),
             transform(sleepy, 1, 1, 4), transform(chibi(Params(blink=1, squash=1, look=-.5)), 1, 1, -6),
             transform(chibi(Params(blink=0, look=-.5)), 1, 1, -4),
             transform(chibi(Params(blink=0, look=.5)), 1, 1, 5),
             chibi(Params(blink=1, look=.2)), sit],
        ], "peak": 4,
    }
    return result


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = ["msyhbd.ttc" if bold else "msyh.ttc", "simhei.ttf", "arial.ttf"]
    for name in names:
        path = Path("C:/Windows/Fonts") / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def sprite_image(c: Canvas, scale: int = 4) -> Image.Image:
    rgba = Image.fromarray(c.to_array(scale), "RGBA")
    bg = Image.new("RGBA", rgba.size, "white")
    bg.alpha_composite(rgba)
    return bg.convert("RGB")


def comparison_frame(spec: dict, index: int, scale: int = 4) -> Image.Image:
    margin, gap, header, label_h, footer = 24, 18, 64, 48, 36
    cell_w, cell_h = W * scale, H * scale
    width = margin * 2 + cell_w * 3 + gap * 2
    height = header + label_h + cell_h + footer + margin
    frame = Image.new("RGB", (width, height), "#F3F5F8")
    draw = ImageDraw.Draw(frame)
    draw.text((margin, 16), f"{spec['title']} · A / B / C 动作候选", font=font(28, True), fill="#20242B")
    for col, name in enumerate(spec["names"]):
        x = margin + col * (cell_w + gap)
        y = header
        draw.rounded_rectangle((x, y, x + cell_w, y + label_h + cell_h), radius=12,
                               fill="white", outline="#D6DCE4", width=2)
        color = ("#965B19", "#246A55", "#505BA8")[col]
        draw.text((x + 14, y + 10), name, font=font(19, True), fill=color)
        frame.paste(sprite_image(spec["variants"][col][index], scale), (x, y + label_h))
    draw.text((margin, height - 30), "统一速度循环，仅比较动作；未替换当前开发版。",
              font=font(16), fill="#68707C")
    return frame


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    specs = candidates()
    manifest = []
    overview_rows = []
    for key, spec in specs.items():
        frames = [comparison_frame(spec, i) for i in range(8)]
        durations = [260] + [160] * 6 + [700]
        if key == "lieDown":
            durations = [260] + [210] * 6 + [800]
        path = OUT / f"{key}-abc.gif"
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations,
                       loop=0, disposal=2, optimize=False)
        overview_rows.append(comparison_frame({**spec, "variants": [
            [variant[spec["peak"]]] for variant in spec["variants"]
        ]}, 0, scale=3))
        manifest.append({"key": key, "title": spec["title"], "file": path.name,
                         "choices": spec["names"], "frames": 8})
        print(f"{key}: {path.name} ({path.stat().st_size} bytes)")

    gap = 14
    sheet = Image.new("RGB", (max(row.width for row in overview_rows),
                              sum(row.height for row in overview_rows) + gap * 6), "#E8ECF1")
    y = 0
    for row in overview_rows:
        sheet.paste(row, (0, y))
        y += row.height + gap
    sheet.save(OUT / "overview.png")
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"overview: {OUT / 'overview.png'}")


if __name__ == "__main__":
    main()
