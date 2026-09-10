"""Tiny pixel-art drawing kit.

Everything the pet is made of is rasterised here from simple primitives so that
new poses, variants and animations are *data*, not new code.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from palette import EMPTY, PALETTE


@dataclass
class Canvas:
    w: int
    h: int
    grid: list[list[str]] = field(init=False)

    def __post_init__(self) -> None:
        self.grid = [[EMPTY for _ in range(self.w)] for _ in range(self.h)]

    # -- primitives -----------------------------------------------------
    def put(self, x: int, y: int, ch: str, overwrite: bool = True) -> None:
        if 0 <= x < self.w and 0 <= y < self.h:
            if overwrite or self.grid[y][x] == EMPTY:
                self.grid[y][x] = ch

    def _flood(self, pred, ch: str, overwrite: bool, bounds=None) -> None:
        x0, y0, x1, y1 = bounds or (0, 0, self.w, self.h)
        for y in range(max(0, y0), min(self.h, y1 + 1)):
            for x in range(max(0, x0), min(self.w, x1 + 1)):
                if pred(x, y):
                    self.put(x, y, ch, overwrite)

    def ellipse(
        self,
        cx: float,
        cy: float,
        rx: float,
        ry: float,
        ch: str,
        *,
        overwrite: bool = True,
        bounds=None,
        squash_bottom: float = 1.0,
    ) -> None:
        """Filled ellipse. squash_bottom<1 flattens the lower half (sitting bodies)."""

        def pred(x: int, y: int) -> bool:
            dy = y - cy
            if dy > 0:
                dy /= max(squash_bottom, 1e-6)
            return ((x - cx) / rx) ** 2 + (dy / ry) ** 2 <= 1.0

        r = max(rx, ry) + 3
        bx = (int(cx - r), int(cy - r - 3), int(cx + r), int(cy + r + 3))
        self._flood(pred, ch, overwrite, bounds or bx)

    def rect(self, x0: int, y0: int, x1: int, y1: int, ch: str, *, overwrite: bool = True) -> None:
        self._flood(lambda x, y: x0 <= x <= x1 and y0 <= y <= y1, ch, overwrite, (x0, y0, x1, y1))

    def triangle(self, pts, ch: str, *, overwrite: bool = True, round_tip: int = 0) -> None:
        (ax, ay), (bx, by), (cx, cy) = pts
        minx, maxx = int(min(ax, bx, cx)) - 1, int(max(ax, bx, cx)) + 1
        miny, maxy = int(min(ay, by, cy)) - 1, int(max(ay, by, cy)) + 1
        dx, dy = bx - ax, by - ay
        ex, ey = cx - ax, cy - ay
        den = dx * ey - dy * ex
        if abs(den) < 1e-9:
            return

        def inside(px: float, py: float) -> bool:
            vx, vy = px - ax, py - ay
            u = (vx * ey - vy * ex) / den
            v = (dx * vy - dy * vx) / den
            return u >= 0 and v >= 0 and u + v <= 1

        def pred(x: int, y: int) -> bool:
            for ox in (0.0, 0.0, 0.4, -0.4):
                for oy in (0.0, 0.4, -0.4):
                    if inside(x + 0.5 + ox, y + 0.5 + oy):
                        return True
            return False

        self._flood(pred, ch, overwrite, (minx, miny, maxx, maxy))

    def arc(
        self,
        cx: float,
        cy: float,
        r: float,
        thickness: float,
        ch: str,
        *,
        a0: float = 0.0,
        a1: float = 360.0,
        overwrite: bool = True,
    ) -> None:
        """Ring segment, angle in degrees measured from +x going clockwise on screen."""
        for y in range(int(cy - r - thickness - 2), int(cy + r + thickness + 3)):
            for x in range(int(cx - r - thickness - 2), int(cx + r + thickness + 3)):
                d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
                if abs(d - r) > thickness / 2:
                    continue
                ang = np.degrees(np.arctan2(y + 0.5 - cy, x + 0.5 - cx)) % 360
                if a0 <= a1:
                    ok = a0 <= ang <= a1
                else:
                    ok = ang >= a0 or ang <= a1
                if ok:
                    self.put(x, y, ch, overwrite)

    # -- composition ----------------------------------------------------
    def blob(self, pts, ch: str, *, overwrite: bool = True) -> None:
        """Union of ellipses: [(cx, cy, rx, ry), ...] -- builds organic body mass."""
        for cx, cy, rx, ry in pts:
            self.ellipse(cx, cy, rx, ry, ch, overwrite=overwrite)

    def region_mask(self, ch: str) -> np.ndarray:
        return np.array([[c == ch for c in row] for row in self.grid], dtype=bool)

    def filled_mask(self) -> np.ndarray:
        return np.array([[c != EMPTY for c in row] for row in self.grid], dtype=bool)

    def repaint(self, mask: np.ndarray, ch: str, *, only: str | None = None) -> None:
        """Repaint pixels where mask is true (optionally only where char == only)."""
        for y in range(self.h):
            for x in range(self.w):
                if mask[y, x] and (only is None or self.grid[y][x] == only):
                    self.grid[y][x] = ch

    def repaint_inside(self, mask: np.ndarray, ch: str, *, only: str | None = None,
                       keep: set[str] | None = None) -> None:
        """Paint where mask is true, but only over *painted* canvas pixels.

        Mask-driven marking must never smear colour into the transparent
        background, which is exactly what a naive repaint does at the silhouette
        edge. ``keep`` protects characters (eyes, nose) from being overwritten.
        """
        keep = keep or set()
        for y in range(self.h):
            for x in range(self.w):
                if not mask[y, x]:
                    continue
                cur = self.grid[y][x]
                if cur == EMPTY or cur in keep:
                    continue
                if only is None or cur == only:
                    self.grid[y][x] = ch

    def spots(self, pts, ch: str, *, only: str | None = None) -> None:
        """Paint soft-edged patches (like calico markings) onto the body."""
        m = np.zeros((self.h, self.w), dtype=bool)
        for cx, cy, r in pts:
            for y in range(self.h):
                for x in range(self.w):
                    if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5 <= r:
                        m[y, x] = True
        # soften: union with a 1px growth so edges look hand-placed, not circular
        grow = m.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            grow |= shift(m, dy, dx)
        self.repaint(grow, ch, only=only)

    def outline(self, ch: str = "L", *, thickness: int = 1) -> None:
        """Add an outline just outside the silhouette (classic sprite read)."""
        base = self.filled_mask()
        grown = base.copy()
        for _ in range(thickness):
            nxt = grown.copy()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nxt |= shift(grown, dy, dx)
            grown = nxt
        ring = grown & ~base
        for y in range(self.h):
            for x in range(self.w):
                if ring[y, x]:
                    self.grid[y][x] = ch

    def flip_h(self) -> "Canvas":
        c = Canvas(self.w, self.h)
        c.grid = [list(reversed(row)) for row in self.grid]
        return c

    def shift(self, dx: int, dy: int) -> "Canvas":
        """Move the whole image inside a same-size canvas (content may clip)."""
        c = Canvas(self.w, self.h)
        for y in range(self.h):
            for x in range(self.w):
                c.put(x + dx, y + dy, self.grid[y][x])
        return c

    def padded(self, left: int = 0, top: int = 0, right: int = 0, bottom: int = 0) -> "Canvas":
        """Grow the canvas and keep the existing art inset by the given margins.

        Different from shift(): the canvas actually gets bigger, so art near the
        edge is no longer clipped by the outline pass.
        """
        c = Canvas(self.w + left + right, self.h + top + bottom)
        for y in range(self.h):
            for x in range(self.w):
                c.grid[y + top][x + left] = self.grid[y][x]
        return c

    def crop_to_content(self, pad: int = 0) -> "Canvas":
        m = self.filled_mask()
        ys, xs = np.nonzero(m)
        if len(ys) == 0:
            return self
        x0, x1 = max(0, xs.min() - pad), min(self.w - 1, xs.max() + pad)
        y0, y1 = max(0, ys.min() - pad), min(self.h - 1, ys.max() + pad)
        c = Canvas(x1 - x0 + 1, y1 - y0 + 1)
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                c.grid[y - y0][x - x0] = self.grid[y][x]
        return c

    # -- output ---------------------------------------------------------
    def to_array(self, scale: int = 1) -> np.ndarray:
        h, w = self.h, self.w
        out = np.zeros((h, w, 4), dtype=np.uint8)
        for y in range(h):
            for x in range(w):
                ch = self.grid[y][x]
                if ch == EMPTY:
                    continue
                r, g, b = PALETTE[ch]
                out[y, x] = (r, g, b, 255)
        if scale > 1:
            out = np.repeat(np.repeat(out, scale, 0), scale, 1)
        return out

    def to_rows(self) -> list[str]:
        return ["".join(row) for row in self.grid]


def shift(mask: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """Shift a boolean mask, filling the vacated edge with False.

    np.roll would wrap: a shape touching the right edge of the sprite would
    smear onto the left edge, which showed up as stray black specks floating
    beside the cat (the outline pass is built on this).
    """
    out = np.zeros_like(mask)
    h, w = mask.shape
    ys_src = slice(max(0, -dy), h - max(0, dy))
    ys_dst = slice(max(0, dy), h - max(0, -dy))
    xs_src = slice(max(0, -dx), w - max(0, dx))
    xs_dst = slice(max(0, dx), w - max(0, -dx))
    out[ys_dst, xs_dst] = mask[ys_src, xs_src]
    return out


def union(*canvases: Canvas) -> Canvas:
    if not canvases:
        raise ValueError("nothing to union")
    w = max(c.w for c in canvases)
    h = max(c.h for c in canvases)
    out = Canvas(w, h)
    for c in canvases:
        for y in range(c.h):
            for x in range(c.w):
                if c.grid[y][x] != EMPTY:
                    out.grid[y][x] = c.grid[y][x]
    return out
