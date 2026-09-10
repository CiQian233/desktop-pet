"""Locate the pet in the recording by motion, then measure how it tracks the cursor.

Colour matching was too fragile (the mask merged the pet with desktop UI). The
pet is the only thing that moves smoothly across the whole desktop, so a frame
difference finds it reliably; contours are then filtered by plausible pet size.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist" / "smoke"


def input_video() -> Path:
    """输入录像不入库：用 PET_VIDEO 环境变量或命令行第一个参数指定。"""
    raw = os.environ.get("PET_VIDEO", "").strip() or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not raw:
        sys.exit("缺少输入录像：设置 PET_VIDEO=<file.mp4>，或 python tools/track_motion.py <file.mp4>")
    path = Path(raw).expanduser()
    if not path.is_file():
        sys.exit(f"录像不存在或不是文件：{path}")
    return path

# the pet is ~230x210 px at 3x on a 2560x1440 screen
MIN_SIDE, MAX_SIDE = 90, 340


def main() -> None:
    cap = cv2.VideoCapture(str(input_video()))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    prev_gray = None
    traj: list[tuple[float, int, int, int, int]] = []
    for i in range(0, total, 3):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, fr = cap.read()
        if not ok:
            continue
        gray = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)
        if prev_gray is None:
            prev_gray = gray
            continue
        d = cv2.absdiff(gray, prev_gray)
        prev_gray = gray
        m = (d > 18).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        best = None
        for c in cnts:
            x, y, w, h = cv2.boundingRect(c)
            if not (MIN_SIDE <= w <= MAX_SIDE and MIN_SIDE <= h <= MAX_SIDE):
                continue
            a = cv2.contourArea(c)
            if best is None or a > best[4]:
                best = (x + w // 2, y + h // 2, w, h, a)
        if best:
            traj.append((i / fps, best[0], best[1], best[2], best[3]))
    cap.release()

    print(f"duration={total / fps:.1f}s   pet located in {len(traj)} samples")
    if len(traj) < 10:
        print("too few samples")
        return

    ts = np.array([t[0] for t in traj])
    xs = np.array([t[1] for t in traj], float)
    ys = np.array([t[2] for t in traj], float)
    print(f"x range {xs.min():.0f}..{xs.max():.0f}  ({100 * np.ptp(xs) / 2560:.0f}% of screen width)")
    print(f"y range {ys.min():.0f}..{ys.max():.0f}  ({100 * np.ptp(ys) / 1440:.0f}% of screen height)")

    dist = np.hypot(np.diff(xs), np.diff(ys))
    print(f"step per 50ms: median {np.median(dist):.1f}  mean {dist.mean():.1f}  max {dist.max():.0f}")
    print(f"samples < 1px movement: {int((dist < 1).sum())} / {len(dist)}")
    rev = int(np.sum(np.sign(np.diff(xs)[1:]) * np.sign(np.diff(xs)[:-1]) < 0))
    print(f"x reversals: {rev}")

    # Find stretches where the pet is stuck: near-zero movement for > 0.5 s
    stuck_runs = []
    run_start = None
    for k, d in enumerate(dist):
        if d < 1.0:
            if run_start is None:
                run_start = k
        else:
            if run_start is not None and k - run_start >= 10:
                stuck_runs.append((ts[run_start], ts[k]))
            run_start = None
    if run_start is not None and len(dist) - run_start >= 10:
        stuck_runs.append((ts[run_start], ts[-1]))
    print(f"\nstuck stretches (>= 0.5s without moving): {len(stuck_runs)}")
    for a, b in stuck_runs[:20]:
        print(f"   {a:6.2f}s .. {b:6.2f}s  ({b - a:.2f}s)")

    print(f"\n{'t(s)':>6} {'x':>6} {'y':>6} {'w':>5} {'h':>5} {'step':>6}")
    for k in range(0, len(traj), 6):
        t, x, y, w, h = traj[k]
        s = dist[k - 1] if k > 0 else 0.0
        print(f"{t:6.2f} {x:6d} {y:6d} {w:5d} {h:5d} {s:6.1f}")


if __name__ == "__main__":
    main()
