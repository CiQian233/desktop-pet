"""Analyse the screen recording of the twitching pet.

Finds the pet by frame differencing, then reports its bounding box and centroid
per sample so the actual motion can be measured instead of guessed.
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
        sys.exit("缺少输入录像：设置 PET_VIDEO=<file.mp4>，或 python tools/analyse_video.py <file.mp4>")
    path = Path(raw).expanduser()
    if not path.is_file():
        sys.exit(f"录像不存在或不是文件：{path}")
    return path


def main() -> None:
    cap = cv2.VideoCapture(str(input_video()))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"fps={fps:.2f} frames={total} size={w}x{h} duration={total / fps:.1f}s")

    # background estimate from widely spaced frames
    bg_frames = []
    for i in range(0, total, 40):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, fr = cap.read()
        if ok:
            bg_frames.append(fr.astype(np.float32))
    bg = np.median(np.stack(bg_frames), axis=0)

    kernel = np.ones((9, 9), np.uint8)
    rows = []
    boxes = []
    for i in range(0, total, 6):          # every 0.1 s
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, fr = cap.read()
        if not ok:
            continue
        d = np.abs(fr.astype(np.float32) - bg).max(axis=-1)
        m = (d > 35).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        c = max(cnts, key=cv2.contourArea)
        x, y, bw, bh = cv2.boundingRect(c)
        if bw * bh < 1500:
            continue
        area = cv2.contourArea(c)
        rows.append((i / fps, x, y, bw, bh, int(area)))
        boxes.append((x, y, bw, bh))

    cap.release()

    print(f"\n{'t(s)':>6} {'x':>6} {'y':>6} {'w':>5} {'h':>5} {'area':>7}")
    for t, x, y, bw, bh, a in rows:
        print(f"{t:6.1f} {x:6d} {y:6d} {bw:5d} {bh:5d} {a:7d}")

    if boxes:
        xs = np.array([b[0] for b in boxes], dtype=float)
        ys = np.array([b[1] for b in boxes], dtype=float)
        print(
            f"\nposition range: x {xs.min():.0f}..{xs.max():.0f} (span {xs.ptp():.0f}), "
            f"y {ys.min():.0f}..{ys.max():.0f} (span {ys.ptp():.0f})"
        )
        # how often does the direction reverse? a twitch shows up as many reversals
        dx = np.diff(xs)
        dy = np.diff(ys)
        flips_x = int(np.sum(np.sign(dx[1:]) * np.sign(dx[:-1]) < 0))
        flips_y = int(np.sum(np.sign(dy[1:]) * np.sign(dy[:-1]) < 0))
        print(f"direction reversals: x={flips_x} y={flips_y} over {len(xs)} samples")
        print(f"max single step:    x={np.abs(dx).max():.0f} y={np.abs(dy).max():.0f} px")


if __name__ == "__main__":
    sys.exit(main())
