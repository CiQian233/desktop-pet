"""Zoom into the pet's corner of the screen recording and measure its motion."""

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
        sys.exit("缺少输入录像：设置 PET_VIDEO=<file.mp4>，或 python tools/zoom_video.py <file.mp4>")
    path = Path(raw).expanduser()
    if not path.is_file():
        sys.exit(f"录像不存在或不是文件：{path}")
    return path


# region of the screen where the pet lives (seen in the frame sheet)
CROP = (1050, 1120, 1750, 1400)      # x0, y0, x1, y1


def main() -> None:
    video = input_video()
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # a strip of zoomed crops at 0.5 s intervals so the motion is visible
    tiles = []
    for i in range(0, total, 30):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, fr = cap.read()
        if not ok:
            continue
        c = fr[CROP[1]:CROP[3], CROP[0]:CROP[2]]
        c = cv2.resize(c, (c.shape[1], c.shape[0]))
        cv2.putText(c, f"{i / fps:.1f}s", (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
        tiles.append(c)
    cap.release()

    if tiles:
        cols = 6
        rows = [np.hstack(tiles[i : i + cols]) for i in range(0, len(tiles), cols)]
        widths = {r.shape[1] for r in rows}
        if len(widths) == 1:
            sheet = np.vstack(rows)
            OUT.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(OUT / "pet_zoom.png"), sheet)
            print("wrote pet_zoom.png", sheet.shape)
        else:
            # pad the last row so the sheet stays rectangular
            wmax = max(r.shape[1] for r in rows)
            padded = [
                np.hstack([r, np.zeros((r.shape[0], wmax - r.shape[1], 3), np.uint8)]) for r in rows
            ]
            sheet = np.vstack(padded)
            OUT.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(OUT / "pet_zoom.png"), sheet)
            print("wrote pet_zoom.png (padded)", sheet.shape)

    # measure the pet's own motion inside the crop, at 60 fps, for 2 s windows
    cap = cv2.VideoCapture(str(video))
    for start_s in (2.0, 6.0, 10.0, 14.0, 18.0):
        start = int(start_s * fps)
        boxes = []
        prev = None
        for i in range(start, min(start + 120, total)):
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, fr = cap.read()
            if not ok:
                break
            c = fr[CROP[1]:CROP[3], CROP[0]:CROP[2]]
            if prev is None:
                prev = c
                continue
            d = cv2.absdiff(c, prev)
            prev = c
            m = (d.max(axis=-1) > 40).astype(np.uint8)
            cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not cnts:
                continue
            big = max(cnts, key=cv2.contourArea)
            if cv2.contourArea(big) < 80:
                continue
            x, y, w, h = cv2.boundingRect(big)
            boxes.append((x, y, w, h))
        if boxes:
            xs = np.array([b[0] for b in boxes], float)
            print(
                f"t={start_s:4.1f}s..{start_s + 2:.1f}s  moving-region x {xs.min():.0f}..{xs.max():.0f}"
                f"  span {xs.ptp():.0f}  samples {len(boxes)}"
            )
    cap.release()


if __name__ == "__main__":
    main()
