"""Low-frequency natural poses built from the existing high-density pixel cat.

Every frame stays on the original 76 x 68 native raster. Transformations operate
on palette pixels (never interpolated RGB), then reuse the same exterior-only
outline pass as the base sprites.
"""

from __future__ import annotations

from PIL import Image

from chibi_hd import Params, chibi
from pixel import Canvas
from palette import EMPTY, PALETTE

W, H = 76, 68


def scaled(source: Canvas, sx: float, sy: float, dx: int = 0, dy: int = 0) -> Canvas:
    """Nearest-neighbour content scaling, anchored to the original ground line."""
    points = [(x, y) for y in range(source.h) for x in range(source.w) if source.grid[y][x] != EMPTY]
    x0 = min(x for x, _ in points)
    x1 = max(x for x, _ in points)
    y0 = min(y for _, y in points)
    y1 = max(y for _, y in points)
    sw, sh = x1 - x0 + 1, y1 - y0 + 1
    tw = max(1, min(W - 4, round(sw * sx)))
    th = max(1, min(H - 4, round(sh * sy)))
    ox = (W - tw) // 2 + dx
    oy = H - 3 - th + dy
    out = Canvas(W, H)
    for y in range(th):
        source_y = y0 + min(sh - 1, int(y * sh / th))
        for x in range(tw):
            source_x = x0 + min(sw - 1, int(x * sw / tw))
            out.put(ox + x, oy + y, source.grid[source_y][source_x])
    out.unify_outer_outline()
    return out


RGBA_TO_CHAR = {(*rgb, 255): ch for ch, rgb in PALETTE.items()}


def transform(source: Canvas, sx: float = 1.0, sy: float = 1.0,
              angle: float = 0.0, dx: int = 0, dy: int = 0) -> Canvas:
    """Nearest-neighbour scale/rotate for the selected candidate poses."""
    image = Image.fromarray(source.to_array(1), "RGBA")
    box = image.getchannel("A").getbbox()
    if not box:
        return Canvas(W, H)
    image = image.crop(box)
    image = image.resize((max(1, round(image.width * sx)),
                          max(1, round(image.height * sy))), Image.Resampling.NEAREST)
    if angle:
        image = image.rotate(angle, Image.Resampling.NEAREST, expand=True)
    factor = min(1.0, (W - 4) / image.width, (H - 4) / image.height)
    if factor < 1.0:
        image = image.resize((max(1, round(image.width * factor)),
                              max(1, round(image.height * factor))), Image.Resampling.NEAREST)
    out = Canvas(W, H)
    ox = (W - image.width) // 2 + dx
    oy = H - 3 - image.height + dy
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            rgba = pixels[x, y]
            if rgba[3]:
                out.put(ox + x, oy + y, RGBA_TO_CHAR.get(tuple(rgba), EMPTY))
    out.unify_outer_outline()
    return out


def tongue(source: Canvas, side: int = -1, length: int = 2) -> Canvas:
    """Small pink tongue used by the selected slow-lick candidate."""
    out = Canvas(W, H)
    out.grid = [list(row) for row in source.grid]
    x = 35 + side * 5
    for i in range(length):
        out.put(x, 33 + i, "P")
        if i == length - 1:
            out.put(x + side, 33 + i, "P")
    out.unify_outer_outline()
    return out


def flip_vertical(source: Canvas) -> Canvas:
    out = Canvas(source.w, source.h)
    out.grid = [list(row) for row in reversed(source.grid)]
    out.unify_outer_outline()
    return out


def flip_horizontal(source: Canvas) -> Canvas:
    out = source.flip_h()
    out.unify_outer_outline()
    return out


def natural_anims() -> dict[str, tuple[str, float, bool, list[Canvas]]]:
    stand = chibi(Params(gait=1, look=0.3))
    # User-selected candidate B: a gentle back-arch instead of the original
    # mostly vertical resize. Selected key poses are retained; bridge poses only
    # smooth their entry, return and largest angular changes.
    stretch = [
        chibi(Params()),
        # Entry/return bridges compensate for transform()'s cropped-bounds
        # centring. The selected key poses below remain byte-for-byte intact.
        transform(stand, 0.99, 0.98, dx=5),
        transform(stand, 0.98, 0.97, dx=2),
        transform(stand, 0.98, 0.96),
        transform(stand, 0.96, 0.99, -2.5),
        transform(stand, 0.94, 1.02, -5),
        transform(stand, 0.92, 1.07, -10, dx=-1),
        transform(stand, 0.94, 1.04, 6, dx=1),
        transform(stand, 0.97, 0.99),
        transform(stand, 0.98, 1.00, dx=4),
        chibi(Params(blink=1)),
        chibi(Params()),
    ]
    # User-selected candidate B: slower side licks with a visible tongue.
    groom_base = [
        chibi(Params(gait=1, look=-1, blink=blink, squash=squash))
        for blink, squash in ((1, 1), (2, 1), (2, 2), (2, 2), (1, 1), (2, 1))
    ]
    groom = [
        chibi(Params()),
        transform(groom_base[0], 1, 1, -1, dx=5),
        transform(groom_base[0], 1, 1, -2, dx=2),
        transform(groom_base[0], 1, 1, -3),
        transform(tongue(groom_base[1], -1, 1), 1, 1, -5),
        transform(tongue(groom_base[2], -1, 3), 1, 1, -7),
        transform(tongue(groom_base[3], -1, 2), 1, 1, -5),
        transform(tongue(groom_base[4], -1, 1), 1, 1, -3),
        transform(groom_base[5], 1, 1, -2),
        transform(groom_base[5], 1, 1, -1, dx=4, dy=1),
        chibi(Params()),
    ]
    scratch = [
        chibi(Params(look=0.4)),
        chibi(Params(gait=1, look=0.6, tail_swing=0.2)),
        chibi(Params(gait=0, look=0.5, blink=1)),
        chibi(Params(gait=-1, look=0.6, tail_swing=-0.2)),
        chibi(Params(gait=1, look=0.5, tail_swing=0.1)),
        chibi(Params(look=0.2)),
    ]
    lie_down = [
        chibi(Params()),
        chibi(Params(squash=1, blink=1)),
        scaled(chibi(Params(squash=2, blink=2, mood="sleepy")), 1.02, 0.95, dx=3),
        scaled(chibi(Params(squash=2, blink=2, mood="sleepy")), 1.03, 0.90),
        scaled(chibi(Params(squash=2, blink=2, mood="sleepy")), 1.08, 0.80),
        scaled(chibi(Params(squash=2, blink=2, mood="sleepy", tail_swing=-0.1)), 1.08, 0.82),
        scaled(chibi(Params(squash=1, blink=2, mood="sleepy")), 1.05, 0.86),
    ]
    sleepy = chibi(Params(squash=2, blink=2, mood="sleepy"))
    # User-selected candidate C: an actual side roll through rotated poses.
    roll = [
        chibi(Params()),
        transform(sleepy, 0.98, 0.98, -15, dx=7, dy=5),
        transform(sleepy, 0.96, 0.96, -25, dx=4, dy=3),
        transform(sleepy, 0.95, 0.95, -30, dx=1, dy=1),
        transform(sleepy, 0.94, 0.94, -35),
        transform(sleepy, 0.91, 0.91, -55),
        transform(sleepy, 0.88, 0.88, -75),
        transform(sleepy, 0.86, 0.86, -95),
        transform(sleepy, 0.85, 0.85, -105, dy=1),
        transform(sleepy, 0.84, 0.84, -115),
        transform(sleepy, 0.86, 0.86, -160),
        transform(sleepy, 0.84, 0.84, -205),
        transform(sleepy, 0.87, 0.87, -252.5, dy=-2),
        transform(sleepy, 0.90, 0.90, -300),
        transform(sleepy, 0.93, 0.93, -330, dx=3),
        chibi(Params()),
    ]
    greet = [
        chibi(Params()),
        chibi(Params(blink=2, squash=1, tail_swing=0.3)),
        chibi(Params(look=0.8, tail_swing=1.0)),
        chibi(Params(look=0.8, blink=1, tail_swing=0.8)),
        chibi(Params(look=0.8, tail_swing=0.5)),
        chibi(Params()),
    ]
    # User-selected candidate B: wake, open eyes, then finish with a stretch.
    wake_up = [
        sleepy,
        chibi(Params(blink=1, squash=2, mood="sleepy")),
        chibi(Params(blink=1, squash=1)),
        chibi(Params(blink=0)),
        transform(stand, 0.99, 1.00, dx=5),
        transform(stand, 0.98, 1.00, dx=2),
        transform(stand, 0.97, 1.00),
        transform(stand, 0.94, 1.06, -4),
        transform(stand, 0.96, 1.04, -2, dx=1),
        transform(stand, 0.97, 1.01),
        transform(stand, 0.98, 1.00, dx=4),
        chibi(Params()),
    ]
    return {
        "stretch": ("伸懒腰", 7.0, False, stretch),
        "groom": ("舔毛", 7.0, False, groom),
        "scratch": ("磨爪", 8.0, False, scratch),
        "lieDown": ("趴下", 5.0, False, lie_down),
        "roll": ("翻肚", 6.0, False, roll),
        "greet": ("启动迎接", 7.0, False, greet),
        "wakeUp": ("睡醒叫醒", 7.0, False, wake_up),
    }


NATURAL_ANIMS = natural_anims()
