"""Zoom hard on specific timestamps to check whether more than one pet is on screen."""

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
        sys.exit("缺少输入录像：设置 PET_VIDEO=<file.mp4>，或 python tools/frames_video.py <file.mp4>")
    path = Path(raw).expanduser()
    if not path.is_file():
        sys.exit(f"录像不存在或不是文件：{path}")
    return path

TIMES = [4.9, 5.2, 5.5, 5.8, 6.1, 6.5, 6.9, 7.2, 7.5, 7.9, 15.4, 15.7, 16.0, 17.4, 17.8]
CROP = (1000, 1100, 1800, 1400)


def main() -> None:
    cap = cv2.VideoCapture(str(input_video()))
    fps = cap.get(cv2.CAP_PROP_FPS)
    tiles = []
    for t in TIMES:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, fr = cap.read()
        if not ok:
            continue
        c = fr[CROP[1] : CROP[3], CROP[0] : CROP[2]].copy()
        # upscale so the sprite pixels are legible
        c = cv2.resize(c, (c.shape[1] * 2, c.shape[0] * 2), interpolation=cv2.INTER_NEAREST)
        cv2.putText(c, f"{t:.1f}s", (8, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
        cv2.rectangle(c, (0, 0), (c.shape[1] - 1, c.shape[0] - 1), (0, 0, 0), 1)
        tiles.append(c)
    cap.release()

    cols = 5
    rows = [np.hstack(tiles[i : i + cols]) for i in range(0, len(tiles), cols)]
    wmax = max(r.shape[1] for r in rows)
    rows = [np.hstack([r, np.zeros((r.shape[0], wmax - r.shape[1], 3), np.uint8)]) for r in rows]
    sheet = np.vstack(rows)
    OUT.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(OUT / "pet_frames.png"), sheet)
    print("wrote pet_frames.png", sheet.shape)


if __name__ == "__main__":
    main()
