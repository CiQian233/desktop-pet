"""Refined high-density chibi cat.

Density and detail target (from the owner's reference screenshot):
  * ~72x68 native pixels instead of 44x42 -- 2.5x the detail budget
  * 3-4 shades per fur family for gradient shading and a lit-from-above look
  * explicit legs with separate paws + toe separations, so walks read clearly
  * almond eyes with eyelid, iris shading, vertical pupil and sparkle
  * a multi-segment tail driven by a taper + sine swing, so it can be lively
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from palette import EMPTY, PALETTE
from pixel import Canvas, shift


def fit_into(c: Canvas, box_w: int, box_h: int) -> Canvas:
    """Scale the art down to fit a box, keeping it centred and pixel-crisp.

    The hanging pose is a stretched cat, so its legs and tail run past the bottom
    of the canvas and get clipped -- measured: the body alone reached y=91 in a
    68px canvas, so the paws and the whole tail were cut off. Shrinking the pose
    when it is held up also happens to read correctly: a cat lifted by the scruff
    looks smaller than one sitting in front of you.
    """
    m = c.filled_mask()
    ys, xs = np.nonzero(m)
    if len(ys) == 0:
        return c
    h = int(ys.max() - ys.min() + 1)
    w = int(xs.max() - xs.min() + 1)
    if h <= box_h and w <= box_w:
        return c

    from PIL import Image

    crop = c.crop_to_content()
    arr = crop.to_array(1)
    factor = min(box_w / w, box_h / h)
    new_w = max(1, int(round(arr.shape[1] * factor)))
    new_h = max(1, int(round(arr.shape[0] * factor)))
    img = Image.fromarray(arr, mode="RGBA").resize((new_w, new_h), Image.NEAREST)
    # re-centre inside the original canvas
    out = Canvas(c.w, c.h)
    ox = (c.w - new_w) // 2
    oy = (c.h - new_h) // 2
    px = img.load()
    for y in range(new_h):
        for x in range(new_w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            out.grid[y + oy][x + ox] = _nearest_char((r, g, b))
    return out


def _nearest_char(rgb: tuple) -> str:
    """Map a rendered colour back to a palette character (exact match expected)."""
    best, dist = EMPTY, None
    for ch, pal in PALETTE.items():
        d = sum((int(a) - int(b)) ** 2 for a, b in zip(rgb, pal))
        if dist is None or d < dist:
            best, dist = ch, d
    return best

# --------------------------------------------------------------------------
# drawing primitives that work in float space (this canvas is big enough that
# integer snapping is visible)
# --------------------------------------------------------------------------


def _ellipse_mask(w: int, h: int, cx: float, cy: float, rx: float, ry: float,
                  sx: float = 1.0, sy: float = 1.0) -> np.ndarray:
    """Squashed ellipse mask; sx/sy scale the lower half (pear-shaped bodies)."""
    X, Y = np.meshgrid(np.arange(w) + 0.5 - cx, np.arange(h) + 0.5 - cy)
    Y = np.where(Y > 0, Y / sy, Y / sy if sy else Y)
    X = np.where(X > 0, X / sx, X / sx if sx else X)
    return (X / rx) ** 2 + (Y / ry) ** 2 <= 1.0


def blob_mask(w: int, h: int, parts) -> np.ndarray:
    m = np.zeros((h, w), dtype=bool)
    for cx, cy, rx, ry in parts:
        m |= _ellipse_mask(w, h, cx, cy, rx, ry)
    return m


def taper_mask(w: int, h: int, pts, widths) -> np.ndarray:
    """Thick polyline with per-point width -- the tail builder."""
    m = np.zeros((h, w), dtype=bool)
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        r0, r1 = widths[i], widths[i + 1]
        steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 3) + 2
        for s in range(steps + 1):
            t = s / steps
            cx = x0 + (x1 - x0) * t
            cy = y0 + (y1 - y0) * t
            r = r0 + (r1 - r0) * t
            m |= _ellipse_mask(w, h, cx, cy, r, r)
    return m


# --------------------------------------------------------------------------
# the sprite
# --------------------------------------------------------------------------


@dataclass
class Params:
    breath: int = 0
    blink: int = 0          # 0 open, 1 half, 2 closed
    look: float = 0.0
    gait: int = 0           # -1 / 0 / +1
    squash: int = 0
    tail_swing: float = 0.0
    mood: str = "neutral"
    dangle: int = 0           # lifted off the ground (being carried)
    hang: float = 0.0         # 0..1 "held up by the scruff": the body stretches,
                              # the legs dangle straight down and the tail hangs
    hang_sway: float = 0.0    # -1..1 small pendulum sway of a hanging cat
    debug: bool = False       # skip the outline pass to inspect raw geometry


def ellipse_face(c: Canvas, part: np.ndarray, base: str, light: str, mid: str,
                 shade: str, deep: str) -> None:
    """Shade a mask with a lit-from-above ramp plus a rim shadow."""
    ys, xs = np.nonzero(part)
    if len(ys) == 0:
        return
    y0, y1 = ys.min(), ys.max()
    span = max(1, y1 - y0)
    for y, x in zip(ys, xs):
        t = (y - y0) / span
        if t < 0.26:
            ch = light
        elif t < 0.62:
            ch = base
        elif t < 0.86:
            ch = mid
        else:
            ch = shade
        c.put(x, y, ch)
    # rim: one pixel inside the silhouette bottom feels too heavy, so shade
    # only the very edge of the lower third
    edge = part & ~_erode(part)
    for y, x in zip(*np.nonzero(edge)):
        if (y - y0) / span > 0.78:
            c.put(x, y, deep)


def _erode(m: np.ndarray) -> np.ndarray:
    """One-pixel erosion that does NOT wrap around the canvas edges."""
    e = m.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        e &= shift(m, dy, dx)
    return e


def chibi(p: Params) -> Canvas:
    # Drawn on a square-ish stage and then inset by PAD so the tail and the
    # outline pass always have room -- art that touches the canvas edge gets
    # clipped and reads as a black line along the sprite border.
    PAD = 2
    W, H = 72, 68
    c = Canvas(W, H)
    # NOTE on `breath`: it must NOT translate the body. Moving the whole cat a
    # couple of pixels up and down made the idle cycle flip between two very
    # different images (~20% of all pixels changed per frame) and the pet
    # visibly juddered in place. Breathing is applied by the renderer as a small
    # canvas-level scale instead, which keeps the silhouette centred.
    d = -p.squash - abs(p.gait) * 0.8
    # `hang` (a cat held up by the scruff) hangs lower and longer than a sitting
    # cat: the rump drops, the legs dangle and the tail falls (each is drawn by
    # its own branch below).
    hang = max(0.0, min(1.0, p.hang))
    # ground line; everything hangs off this so squash reads as weight
    ground = 65.0 + hang * 1.0 - p.dangle * 6.0

    # small pendulum sway about the scruff: shifts the lower body sideways, which
    # is what makes a held cat read as hanging rather than frozen
    sway_lo = p.hang_sway * (1.0 + 2.4 * hang)

    hx, hy = 33.0 + p.gait * 0.25 + p.hang_sway * 0.9, 25.0 + d * 0.35 - 3.0 * hang
    hrx, hry = 15.5, 13.5

    # ---------------- tail (behind the body) --------------------------
    # A real tail: leaves the rump, sweeps out to the right, curls up and the
    # tip flips back. Multi-segment so the sine swing actually reads as motion.
    # The taper stops at 2.6px on purpose -- thinner than that and the upper
    # stretch degenerates into a detached 1px line floating beside the cat.
    seg = 9
    sway = p.tail_swing
    pts, widths = [], []
    for i in range(seg + 1):
        t = i / seg
        if hang > 0.0:
            # A held cat's tail HANGS: it leaves the RUMP (behind and to the right
            # of the haunch, not under the head) and falls past the body, the tip
            # lagging behind the sway. Starting it at x=44 under the belly buried
            # it behind the body, so it read as if the cat had no tail at all.
            x = 50.0 + p.hang_sway * (1.6 + 3.2 * t * t) + 1.2 * np.sin(t * 3.0)
            y = 48.0 + (15.0 * t) + 1.6 * t * t
            pts.append((x, y))
            widths.append(4.4 - 1.9 * t)
            continue
        ang = np.radians(88 - 96 * t)           # 88deg -> -8deg, sweeping up-right
        rad = 12.0 + 5.0 * t
        x = 48.0 + np.cos(ang) * rad * (0.85 + 0.30 * t) + sway * t * 7.5
        y = 45.0 + np.sin(ang) * rad * 0.66 - sway * t * 3.2
        pts.append((x, y))
        widths.append(4.4 - 1.8 * t)
    tail = taper_mask(W, H, pts, widths)
    # banded calico tail: ink base, ginger mid band, ink tip
    ys, xs = np.nonzero(tail)
    x0, x1 = xs.min(), xs.max()
    span = max(1, x1 - x0)
    for y, x in zip(ys, xs):
        t = (x - x0) / span
        if t < 0.30:
            ch = "k"
        elif t < 0.46:
            ch = "K"
        elif t < 0.64:
            ch = "o"
        elif t < 0.74:
            ch = "O"
        else:
            ch = "k"
        c.put(x, y, ch)
    # top-lit tail shading
    ty0, ty1 = ys.min(), ys.max()
    for y, x in zip(ys, xs):
        if y < ty0 + (ty1 - ty0) * 0.28:
            cur = c.grid[y][x]
            c.put(x, y, {"k": "K", "K": "K", "o": "O", "O": "O"}.get(cur, cur))
    edge = tail & ~_erode(tail)
    for y, x in zip(*np.nonzero(edge)):
        c.put(x, y, "i")

    # ---------------- body -------------------------------------------
    # A sitting cat is a squat blob; a cat held up by the scruff hangs as a longer,
    # narrower one with the rump dropping well below the shoulder. Blending the
    # two by stretching the sitting blobs did not work (the result was a tall
    # rectangle that ran off the canvas), so the hanging blob is its own shape.
    if hang > 0.0:
        body = blob_mask(W, H, [
            (40.0 + sway_lo * 0.6, 52.0 + 2.0 * hang, 11.0, 11.0),           # rump
            (34.0 + sway_lo * 0.8, 45.0 + 1.0 * hang, 10.5, 11.0),           # belly
            (33.0 + sway_lo * 0.4, 33.0, 11.5, 9.0),                         # shoulder
        ])
    else:
        body = blob_mask(W, H, [
            (44.0, 50.0 + d * 0.7, 13.5, 13.0),      # haunch
            (33.0, 51.5 + d * 0.7, 12.5, 12.5),      # belly
            (35.0, 42.0 + d * 0.6, 13.0, 11.0),      # shoulder
        ])
    ellipse_face(c, body, "w", "W", "w", "w2", "w3")
    # ginger saddle + ink patches over the back
    X, Y = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    ginger = body & (((X - 46) / 15.0) ** 2 + ((Y - 44) / 13.0) ** 2 <= 1.0)
    for y, x in zip(*np.nonzero(ginger)):
        c.put(x, y, "O" if y < 41 else "o")
    ink = body & ((((X - 52) / 10.0) ** 2 + ((Y - 38) / 9.0) ** 2 <= 1.0)
                  | (((X - 27) / 7.5) ** 2 + ((Y - 37) / 7.0) ** 2 <= 1.0))
    for y, x in zip(*np.nonzero(ink)):
        c.put(x, y, "K" if y < 40 else "k")

    # ---------------- chest bib (under the legs) ---------------------
    bib = blob_mask(W, H, [
        (29.0, 48.0 + d * 0.6, 8.6, 9.4),
        (31.0, 38.0 + d * 0.5, 7.2, 7.0),
    ])
    ellipse_face(c, bib, "W", "W", "W", "w", "w2")

    # ---------------- legs (in front of the bib) ---------------------
    # Two clearly separated front legs, each ending in a paw with toe splits
    # and a contact shadow, so walking reads at a glance.
    # Sitting: keep the legs narrow and slightly darker than the bib so they
    # read as two pillars; walking: widen the stance and lift alternating paws.
    if p.gait == 0:
        legs = [(27.0, "w2"), (33.5, "w")]
    elif p.gait > 0:
        legs = [(23.0, "w2"), (37.0, "w")]
    else:
        legs = [(29.0, "w2"), (31.5, "w")]
    if hang > 0.0:
        # front paws come together a little as they dangle, and the whole leg
        # swings with the body
        legs = [(27.0 + sway_lo * 0.8, "w2"), (33.5 + sway_lo * 0.8, "w")]
    for i, (lx, tone) in enumerate(legs):
        lift = 0.0
        if p.gait != 0:
            step = p.gait * (1 if i == 0 else -1)
            lift = max(0.0, step) * 3.4
            lx += step * 1.4
        top = 43.0 + d * 0.5 - 2.0 * hang
        bottom = ground - lift
        if hang > 0.0:
            # a dangling front leg starts lower on the body and runs all the way
            # down: no weight on it, so it is slightly thinner as well
            top = 41.0 - 2.0 * hang
            legw = 3.2
        else:
            legw = 3.4
        leg = blob_mask(W, H, [(lx, (top + bottom) / 2, legw, (bottom - top) / 2)])
        for y, x in zip(*np.nonzero(leg)):
            c.put(x, y, tone)
        # inner edge darker so the two legs never merge into one white mass
        leg_edge = leg & ~_erode(leg)
        for y, x in zip(*np.nonzero(leg_edge)):
            inner = 1 if i == 0 else -1
            if (x - lx) * inner > 0 and y < bottom - 4:
                c.put(x, y, "w2" if i == 0 else "w")
        paw_y = ground - 2.6 - lift
        for y, x in zip(*np.nonzero(_ellipse_mask(W, H, lx - (1.4 if i == 0 else 0),
                                                  paw_y, 4.4, 3.0))):
            c.put(x, y, "W" if i == 1 else "w")
        paw_x = lx - (1.4 if i == 0 else 0)
        paw = _ellipse_mask(W, H, paw_x, paw_y, 4.4, 3.0)
        paw_edge = paw & ~_erode(paw)
        for y, x in zip(*np.nonzero(paw_edge)):
            if y >= paw_y:
                c.put(x, y, "w3")
        for t in (-1.8, 0.2, 2.2):        # toe separations
            for k in range(2):
                c.put(int(paw_x + t), int(paw_y + 0.6) + k, "w2")

    # ---------------- head -------------------------------------------
    head = _ellipse_mask(W, H, hx, hy, hrx, hry)
    # ears first (they sit behind the skull)
    for sgn, fur in ((-1, "o"), (1, "k")):
        bx = hx + sgn * hrx * 0.60
        tipx = hx + sgn * (hrx * 0.60 + 6.6)
        base_y = hy - hry * 0.46
        ear = np.zeros((H, W), dtype=bool)
        for s in range(70):
            t = s / 69
            cx = bx + (tipx - bx) * t
            cy = base_y - 7.4 * t
            r = 5.4 * (1 - t) + 0.7
            ear |= _ellipse_mask(W, H, cx, cy, r * 1.10, r * 1.45)
        ear &= ~head
        for y, x in zip(*np.nonzero(ear)):
            c.put(x, y, fur)
        inner = ear & _ellipse_mask(W, H, bx + (tipx - bx) * 0.30,
                                    base_y - 2.4, 1.9, 3.4)
        for y, x in zip(*np.nonzero(inner)):
            c.put(x, y, "p")
        ear_edge = ear & ~_erode(ear)
        for y, x in zip(*np.nonzero(ear_edge)):
            c.put(x, y, "i")

    ellipse_face(c, head, "W", "W", "W", "w", "w2")
    # calico cap: ginger half, ink half, white blaze down the middle
    Xc = (X - hx) / hrx
    Yc = (Y - hy) / hry
    blaze = head & (np.abs(Xc) < 0.20) & (Yc < 0.52)
    cap_g = head & (Xc < -0.12) & (Yc < 0.06)
    cap_i = head & (Xc > 0.18) & (Yc < -0.02)
    for y, x in zip(*np.nonzero(cap_i & ~blaze)):
        c.put(x, y, "K" if Yc[y, x] > -0.55 else "k")
    for y, x in zip(*np.nonzero(cap_g & ~blaze & ~cap_i)):
        c.put(x, y, "O" if Yc[y, x] > -0.5 else "o")
    for y, x in zip(*np.nonzero(blaze)):
        c.put(x, y, "W")

    # muzzle
    muz = _ellipse_mask(W, H, hx - 1.0, hy + hry * 0.44, hrx * 0.56, hry * 0.46)
    ellipse_face(c, muz, "W", "W", "W", "w", "w2")

    # ---------------- eyes -------------------------------------------
    ey = hy - hry * 0.16 + d * 0.3
    sleepy = p.mood == "sleepy"
    angry = p.mood == "angry"
    for sgn in (-1, 1):
        ex = hx + sgn * hrx * 0.44
        lid = _ellipse_mask(W, H, ex, ey, 4.6, 4.2)
        if p.blink == 2:
            closed = lid & _ellipse_mask(W, H, ex, ey - 1.0, 5.0, 5.4)
            for y, x in zip(*np.nonzero(closed)):
                c.put(x, y, "k")
            # a lifted lower lid keeps a closed eye from reading as a dead slit
            if sleepy:
                c.arc(ex, ey - 1.0, 2.4, 1.0, "w3", a0=200, a1=340)
            continue
        for y, x in zip(*np.nonzero(lid)):          # dark rim / lash line
            c.put(x, y, "k")
        iris = _ellipse_mask(W, H, ex + p.look * sgn, ey + 0.4, 3.5, 3.3)
        for y, x in zip(*np.nonzero(iris)):
            t = (y - (ey - 3.3)) / 6.6
            c.put(x, y, "A" if t < 0.35 else "a" if t < 0.72 else "a2")
        pupil = _ellipse_mask(W, H, ex + p.look * sgn, ey + 0.6, 1.5, 2.9)
        for y, x in zip(*np.nonzero(pupil)):
            c.put(x, y, "i")
        c.put(int(ex - 1.6 + p.look * sgn), int(ey - 1.6), "H")     # sparkle
        c.put(int(ex - 0.8 + p.look * sgn), int(ey - 1.2), "H")
        c.put(int(ex + 1.6 + p.look * sgn), int(ey + 1.8), "A")     # bounce light
        if p.blink == 1 or sleepy:
            lidhalf = lid & _ellipse_mask(W, H, ex, ey - (2.6 if p.blink else 1.8),
                                          5.2, 4.0)
            for y, x in zip(*np.nonzero(lidhalf)):
                c.put(x, y, "k")
        if angry:
            # slanted brow sitting just above the lid: outer end high, inner low
            for k in range(9):
                bx = int(ex + sgn * (-4.2 + k))
                by = int(ey - 6.4 + k * 0.60)
                for t in range(2):
                    c.put(bx, by + t, "k")

    # ---------------- nose / mouth -----------------------------------
    ny = hy + hry * 0.34 + d * 0.3
    nose = np.zeros((H, W), dtype=bool)
    for yy in range(int(ny - 2), int(ny + 2)):
        half = 2.6 - abs(yy - ny) * 1.5
        for xx in range(int(hx - half) - 1, int(hx + half) + 2):
            if abs(xx - hx) <= half:
                nose[yy, xx] = True
    for y, x in zip(*np.nonzero(nose)):
        c.put(x, y, "P")
    c.put(int(hx), int(ny + 2), "o2")
    c.put(int(hx - 1), int(ny + 3), "S")
    c.put(int(hx + 1), int(ny + 3), "S")

    # ---------------- outline + grounding ----------------------------
    if not p.debug:
        c.outline("L")

    # Whiskers go on LAST, and in a colour reserved for them.
    # Drawn before the outline they are isolated 1px strokes, so the outline
    # pass rims every one of them and the cat looks like it has long black lines
    # scrawled across its face.
    ny_w = ny + 3
    for sgn in (-1, 1):
        for k, dy in enumerate((0, 2)):
            for s in range(1, 6):
                wob = 1 if (k == 1 and s >= 4) else 0
                c.put(int(hx + sgn * (6 + s)), int(ny_w + dy + wob), "X")

    c.put(int(hx), int(ground + 1), ".")

    # The hanging pose is taller than the canvas; shrink it to fit rather than
    # letting the paws and tail be clipped.
    if hang > 0.0:
        PAD = 2
        c = fit_into(c, W - PAD * 2, H - PAD * 2)
        return c.padded(PAD, 0, PAD, 0)

    return c.padded(PAD, 0, PAD, 0) if PAD else c
