"""Guard against animations that jump instead of looping.

Two failure modes this catches, both of which the user experienced as "twitching":

1. **A pose that translates.** If consecutive frames of an idle animation differ
   across most of the sprite, the pet is not breathing in place, it is hopping.
   An earlier `sit` moved the whole body per frame (~20% of all pixels) and that
   was the actual cause of the reported juddering.

2. **A broken loop seam.** In a looping animation the wrap-around transition must
   not be an outlier: ending on "leg forward" and wrapping to "other leg forward"
   swaps both legs within one frame. The seam is compared against the median of
   the other transitions, so a gait cycle (where legs legitimately move a lot) is
   fine as long as the seam is no worse than the rest.

Run after exporting:  python tools/check_frames.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / "art" / "sprites" / "chibi-hd"

# A frame-to-frame change this large means the pet is not "breathing in place".
# Animations whose subject is a visible pose change are exempt (see below).
MAX_SINGLE_CHANGE_PCT = 15.0
# The wrap-around transition may be at most this many times the typical one.
MAX_SEAM_RATIO = 2.5

# Animations whose subject is a real pose change, so a large frame-to-frame
# difference is correct rather than a defect. Their loop seam is still checked.
POSE_ANIMATIONS = {"walk", "blink", "pat", "angry"}

# Non-looping animations never wrap from the last frame back to the first, so
# the seam is not part of what the player shows.
NON_LOOPING = {"pat"}


def load(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.int16)


def changed_pixels(a: np.ndarray, b: np.ndarray) -> int:
    return int((np.abs(a - b).sum(axis=-1) > 30).sum())


def opaque(a: np.ndarray) -> int:
    return int((a[:, :, 3] > 0).sum())


def main() -> int:
    meta = json.loads((SPRITES / "meta.json").read_text(encoding="utf-8"))
    failures: list[str] = []

    print(f"{'anim':<8} {'frames':>6} {'median':>9} {'seam':>9} {'seam/med':>9}  verdict")
    for key, anim in meta["anims"].items():
        # meta paths are relative to the shipped sprite dir ("frames/sit_0.png"),
        # while the generator writes flat names next to meta.json
        files = [SPRITES / Path(f).name for f in anim["frames"]]
        count = len(files)
        if count < 2:
            print(f"{key:<8} {count:>6}  (single frame, nothing to check)")
            continue

        imgs = [load(f) for f in files]
        base = opaque(imgs[0]) or 1
        steps = [changed_pixels(imgs[i], imgs[(i + 1) % count]) for i in range(count)]
        seam = steps[-1]
        others = steps[:-1] if count > 2 else steps
        median = float(np.median(others)) if others else float(seam)
        ratio = seam / median if median > 0 else 0.0

        problems = []
        if key not in POSE_ANIMATIONS:
            worst_pct = 100.0 * max(steps) / base
            if worst_pct > MAX_SINGLE_CHANGE_PCT:
                problems.append(f"changes {worst_pct:.1f}% of the sprite between frames")
        if count > 2 and key not in NON_LOOPING and ratio > MAX_SEAM_RATIO:
            problems.append(f"loop seam is {ratio:.1f}x the typical step")

        verdict = "OK" if not problems else "FAIL: " + "; ".join(problems)
        print(
            f"{key:<8} {count:>6} {median:>9.0f} {seam:>9d} {ratio:>9.2f}  {verdict}"
        )
        if problems:
            failures.append(f"{key}: {'; '.join(problems)}")

    print()
    if failures:
        print("FAILED:")
        for f in failures:
            print(f"  - {f}")
        print(
            "\nAn idle animation must be a pose that breathes in place; a looping\n"
            "one must not jump at the seam."
        )
        return 1
    print("PASS: animations breathe in place and loop cleanly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
