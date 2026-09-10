"""Crop tightly around the tracked pet and lay the frames out as a filmstrip.

This is the closest thing to watching the recording: if the pet twitches, the
strip will show it jumping back and forth between neighbouring columns.
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
        sys.exit("缺少输入录像：设置 PET_VIDEO=<file.mp4>，或 python tools/filmstrip.py <file.mp4>")
    path = Path(raw).expanduser()
    if not path.is_file():
        sys.exit(f"录像不存在或不是文件：{path}")
    return path

# the pet sits near the bottom edge; track it by the ink-and-ginger signature
BAND_TOP = 1230
HALF_W = 130
HALF_H = 105


def pet_centre(frame: np.ndarray) -> tuple[int, int] | None:
    band = frame[BAND_TOP : BAND_TOP + 170, :, :]
    b = band[:, :, 0].astype(np.int16)
    g = band[:, :, 1].astype(np.int16)
    r = band[:, :, 2].astype(np.int16)
    ginger = (r - b > 42) & (r - g > 22) & (r > 120) & (r < 245)
    ink = (r < 85) & (g < 85) & (b < 85)
    m = (ginger | ink).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in cnts:
        a = cv2.contourArea(c)
        x, y, w, h = cv2.boundingRect(c)
        if a < 1400 or w < 55 or h < 45:
            continue
        if best is None or a > best[0]:
            best = (a, x + w // 2, y + h // 2)
    if best is None:
        return None
    return best[1], BAND_TOP + best[2]


def main() -> None:
    cap = cv2.VideoCapture(str(input_video()))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))

    # 30 consecutive frames at 8 fps so the gaps are visible but the strip is readable
    start = int(8.5 * fps)
    step = int(fps / 8)
    tiles = []
    centres = []
    for k in range(30):
        i = start + k * step
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, fr = cap.read()
        if not ok:
            continue
        c = pet_centre(fr)
        if c is None:
            # blank placeholder, sized to match the upscaled crops
            tiles.append(np.zeros((2 * HALF_H * 2, 2 * HALF_W * 2, 3), np.uint8))
            centres.append(None)
            continue
        cx, cy = c
        centres.append((i / fps, cx, cy))
        x0 = max(0, min(w - 2 * HALF_W, cx - HALF_W))
        y0 = max(0, min(h - 2 * HALF_H, cy - HALF_H))
        crop = fr[y0 : y0 + 2 * HALF_H, x0 : x0 + 2 * HALF_W].copy()
        crop = cv2.resize(crop, (crop.shape[1] * 2, crop.shape[0] * 2), interpolation=cv2.INTER_NEAREST)
        cv2.putText(crop, f"{i / fps:.2f}s", (6, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        tiles.append(crop)
    cap.release()

    cols = 6
    rows = [np.hstack(tiles[i : i + cols]) for i in range(0, len(tiles), cols)]
    widths = {r.shape[1] for r in rows}
    wmax = max(widths)
    rows = [np.hstack([r, np.zeros((r.shape[0], wmax - r.shape[1], 3), np.uint8)]) for r in rows]
    sheet = np.vstack(rows)
    OUT.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(OUT / "pet_filmstrip.png"), sheet)
    print("wrote pet_filmstrip.png", sheet.shape)

    print("\ntracked centres (t, x, y):")
    xs = []
    for c in centres:
        if c is None:
            print("   (pet not found)")
            continue
        t, cx, cy = c
        xs.append(cx)
        print(f"   {t:6.2f}s  x={cx:5d}  y={cy:5d}")
    if len(xs) > 1:
        d = np.diff(np.array(xs, float))
        print(f"\nstep between samples: {[int(v) for v in d]}")
        print(f"max |step| = {np.abs(d).max():.0f}px, reversals = {int(np.sum(np.sign(d[1:]) * np.sign(d[:-1]) < 0))}")


if __name__ == "__main__":
    main()
