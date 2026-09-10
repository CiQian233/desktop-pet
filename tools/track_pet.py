"""Track the pet through the screen recording and look for stuck / jerky motion.

Samples the whole screen (not a fixed band, so the pet is found wherever it is),
builds a trajectory, and reports how smooth the motion is. Also reports whether
the pet ever sits perfectly still while the mode suggests it should be moving.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import cv2
import numpy as np


def input_video() -> Path:
    """输入录像不入库：用 PET_VIDEO 环境变量或命令行第一个参数指定。"""
    raw = os.environ.get("PET_VIDEO", "").strip() or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not raw:
        sys.exit("缺少输入录像：设置 PET_VIDEO=<file.mp4>，或 python tools/track_pet.py <file.mp4>")
    path = Path(raw).expanduser()
    if not path.is_file():
        sys.exit(f"录像不存在或不是文件：{path}")
    return path


def pet_mask(frame: np.ndarray) -> np.ndarray:
    """Pixels that look like the pet: ginger fur, ink patches, bright white body."""
    b = frame[:, :, 0].astype(np.int16)
    g = frame[:, :, 1].astype(np.int16)
    r = frame[:, :, 2].astype(np.int16)
    ginger = (r - b > 46) & (r - g > 24) & (r > 125) & (r < 245)
    ink = (r < 80) & (g < 80) & (b < 80)
    m = (ginger | ink).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    return m


def find_pet(frame: np.ndarray) -> tuple[int, int, int, int, int] | None:
    """Largest pet-like blob: (cx, cy, w, h, area)."""
    m = pet_mask(frame)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in cnts:
        a = cv2.contourArea(c)
        if a < 3000:
            continue
        x, y, w, h = cv2.boundingRect(c)
        # the pet is a compact blob roughly 150-260 px across on this display
        if not (90 <= w <= 320 and 90 <= h <= 320):
            continue
        if best is None or a > best[4]:
            best = (x + w // 2, y + h // 2, w, h, int(a))
    return best


def main() -> None:
    cap = cv2.VideoCapture(str(input_video()))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    traj: list[tuple[float, int, int, int, int]] = []
    for i in range(0, total, 3):        # ~20 samples per second
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, fr = cap.read()
        if not ok:
            continue
        p = find_pet(fr)
        if p:
            traj.append((i / fps, p[0], p[1], p[2], p[3]))
    cap.release()

    print(f"fps={fps:.1f} duration={total / fps:.1f}s   pet found in {len(traj)} samples")

    if not traj:
        print("pet never detected -- check the mask thresholds")
        return

    ts = np.array([t[0] for t in traj])
    xs = np.array([t[1] for t in traj], float)
    ys = np.array([t[2] for t in traj], float)

    print(f"\npet x range {xs.min():.0f}..{xs.max():.0f}   y range {ys.min():.0f}..{ys.max():.0f}")

    # per-sample step, in pixels per 50 ms
    dx = np.diff(xs)
    dy = np.diff(ys)
    dist = np.hypot(dx, dy)
    print(f"step: median {np.median(dist):.1f}px  mean {dist.mean():.1f}px  max {dist.max():.0f}px")
    still = int((dist < 1.0).sum())
    print(f"samples with < 1px movement: {still} / {len(dist)}")
    rev = int(np.sum(np.sign(dx[1:]) * np.sign(dx[:-1]) < 0))
    print(f"x direction reversals: {rev} over {len(xs)} samples")

    # console-style printout so the trajectory can be eyeballed
    print(f"\n{'t(s)':>6} {'x':>6} {'y':>6} {'step':>6}")
    for k in range(0, len(traj), 8):
        t, x, y, _w, _h = traj[k]
        s = dist[k - 1] if k > 0 else 0.0
        print(f"{t:6.2f} {x:6d} {y:6d} {s:6.1f}")

    # how much of the screen width does the pet actually traverse?
    print(f"\nhorizontal coverage: {100 * (xs.max() - xs.min()) / 2560:.0f}% of screen width")


if __name__ == "__main__":
    main()
