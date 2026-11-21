"""Validate every generated sprite, including canvas-edge safety.

Run through scripts/check-sprite-assets.ps1 so the project virtualenv is used.
The JSON report is a build artifact and is not shipped with the application.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from palette import PALETTE  # noqa: E402

OUT = ROOT / "art" / "sprites" / "chibi-hd"


def components(mask: np.ndarray) -> int:
    seen = np.zeros(mask.shape, dtype=bool)
    count = 0
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        count += 1
        seen[y, x] = True
        queue = [(y, x)]
        while queue:
            cy, cx = queue.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((ny, nx))
    return count


def centroid(frame: np.ndarray) -> np.ndarray:
    ys, xs = np.nonzero(frame[:, :, 3] > 0)
    return np.array([xs.mean(), ys.mean()])


def audit() -> dict:
    meta = json.loads((OUT / "meta.json").read_text(encoding="utf-8"))
    allowed = {tuple(rgb) for rgb in PALETTE.values()}
    report: dict = {
        "animations": {}, "totals": {}, "outlineFailures": [], "edgeFailures": [],
        "paletteFailures": [], "alphaFailures": [], "missingFiles": [], "largestJumps": [],
        "transitionFailures": [],
    }
    expected_native: set[str] = set()
    expected_source: set[str] = set()
    for key, anim in meta["anims"].items():
        frames: list[tuple[str, np.ndarray]] = []
        for i in range(anim["count"]):
            expected_native.add(f"{key}_{i}@1x.png")
            expected_source.add(f"{key}_{i}.png")
            path = OUT / f"{key}_{i}@1x.png"
            if not path.exists() or not (OUT / f"{key}_{i}.png").exists():
                report["missingFiles"].append(f"{key}_{i}")
                continue
            image = Image.open(path).convert("RGBA")
            frame = np.array(image)
            frames.append((path.name, frame))
            if image.size != (76, 68):
                raise AssertionError(f"{path.name}: expected 76x68, got {image.size}")
            if not set(np.unique(frame[:, :, 3]).tolist()) <= {0, 255}:
                report["alphaFailures"].append(path.name)
            rgb = frame[:, :, :3][frame[:, :, 3] > 0]
            bad = [tuple(pixel) for pixel in rgb if tuple(pixel) not in allowed]
            if bad:
                report["paletteFailures"].append({"frame": path.name, "count": len(bad)})
            if (np.any(frame[0, :, 3]) or np.any(frame[-1, :, 3]) or
                    np.any(frame[:, 0, 3]) or np.any(frame[:, -1, 3])):
                report["edgeFailures"].append(path.name)
            outline = np.all(frame[:, :, :3] == PALETTE["L"], axis=2) & (frame[:, :, 3] > 0)
            count = components(outline)
            if count != 1:
                report["outlineFailures"].append({"frame": path.name, "components": count})
        jumps = []
        for i in range(1, len(frames)):
            before, after = frames[i - 1][1], frames[i][1]
            changed = float(np.any(before != after, axis=2).mean())
            delta = float(np.linalg.norm(centroid(before) - centroid(after)))
            jump = {"animation": key, "transition": f"{i - 1}->{i}", "frame": frames[i][0],
                    "changedRatio": round(changed, 4), "centroidDelta": round(delta, 2)}
            jumps.append(jump)
            report["largestJumps"].append(jump)
            if key in {"stretch", "groom", "scratch", "lieDown", "roll", "greet", "wakeUp"} and (
                    changed > 0.42 or delta > 4.5):
                report["transitionFailures"].append(jump)
        report["animations"][key] = {
            "frames": len(frames),
            "uniqueFrames": len({hashlib.sha256(frame.tobytes()).hexdigest() for _, frame in frames}),
            "maxChangedRatio": max((jump["changedRatio"] for jump in jumps), default=0),
            "maxCentroidDelta": max((jump["centroidDelta"] for jump in jumps), default=0),
        }
    actual_native = {path.name for path in OUT.glob("*@1x.png")}
    actual_source = {path.name for path in OUT.glob("*.png") if "@1x" not in path.name}
    report["unreferencedSourceFiles"] = sorted(actual_source - expected_source)
    report["unexpectedNativeFiles"] = sorted(actual_native - expected_native)
    report["totals"] = {
        "metaAnimations": len(meta["anims"]),
        "metaFrames": sum(anim["count"] for anim in meta["anims"].values()),
        "nativePngFiles": len(actual_native),
        "source6xPngFiles": len(actual_source),
        "nativeBytes": sum(path.stat().st_size for path in OUT.glob("*@1x.png")),
        "decodedNativeRGBABytes": sum(anim["count"] * 76 * 68 * 4 for anim in meta["anims"].values()),
    }
    report["largestJumps"] = sorted(
        report["largestJumps"], key=lambda item: (item["centroidDelta"], item["changedRatio"]), reverse=True
    )[:16]
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(ROOT / "dist" / "audit-current" / "asset-audit.json"))
    args = parser.parse_args()
    report = audit()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    failures = {key: report[key] for key in (
        "missingFiles", "unexpectedNativeFiles", "outlineFailures", "edgeFailures", "paletteFailures", "alphaFailures",
        "transitionFailures",
    ) if report[key]}
    summary = {"totals": report["totals"], "failures": failures,
               "unreferencedSourceFiles": report["unreferencedSourceFiles"], "report": str(output)}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
