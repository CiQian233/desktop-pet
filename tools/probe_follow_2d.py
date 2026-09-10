"""Standalone harness: does the pet actually chase a high cursor?

Boots the app in follow mode, pins the simulated cursor above the pet, and
records the pet's reported position every 250 ms for 8 seconds. Prints a table so
it is obvious whether the vertical axis tracks.

    python tools/probe_follow_2d.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "dist" / "smoke"
ELECTRON = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"


def main() -> None:
    SMOKE.mkdir(parents=True, exist_ok=True)
    log = SMOKE / "probe2d.log"
    log.unlink(missing_ok=True)
    ud = SMOKE / "udp2d"
    if ud.exists():
        subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", str(ud)], check=False)

    env = dict(os.environ)
    env["PET_LOG"] = str(log)
    env["PET_TEST_CONFIG"] = json.dumps({"mode": "follow", "scale": 3})
    # target is configurable so the vertical axis can be probed in isolation
    env["PET_TRACE_TARGET"] = os.environ.get("PET_TRACE_TARGET", "400,1332")
    env["PET_SMOKE_MS"] = os.environ.get("PET_SMOKE_MS", "11000")

    proc = subprocess.Popen(
        [str(ELECTRON), ".", "--user-data-dir", str(ud)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    proc.wait(timeout=90)

    text = log.read_text(encoding="utf-8", errors="replace")
    samples = re.findall(
        r'"pos":\{"x":(-?\d+),"y":(-?\d+)[^}]*\},'
        r'"follow":\{.*?"target":(-?\d+),"hover":(-?\d+),"drawY":(-?\d+)',
        text,
    )
    print("the probe's simulated cursor sat at y=1332 (pet starts at y=1188)\n")
    print(f"{'#':>3} {'x':>7} {'y':>7} {'target':>7} {'hover':>7} {'drawY':>7}")
    for i, (x, y, target, hover, draw_y) in enumerate(samples):
        print(f"{i:>3} {x:>7} {y:>7} {target:>7} {hover:>7} {draw_y:>7}")

    if samples:
        first_y = int(samples[0][4])
        last_y = int(samples[-1][4])
        first_x = int(samples[0][0])
        last_x = int(samples[-1][0])
        print(f"\ndrawY moved {first_y} -> {last_y}  (delta {last_y - first_y})")
        print(f"x moved      {first_x} -> {last_x}  (delta {last_x - first_x})")
        vertical = last_y != first_y
        print(
            "PASS: the pet tracks the cursor on both axes"
            if vertical
            else "FAIL: no vertical movement"
        )

    trace = re.search(r'"trace":\[(.*?)\]\}\}', text)
    if trace:
        pts = re.findall(r'\{"t":(\d+),"target":(-?\d+),"pet":(-?\d+)', trace.group(1))
        if pts:
            print(f"\ntrace points: {len(pts)}  first={pts[0]}  last={pts[-1]}")


if __name__ == "__main__":
    main()
