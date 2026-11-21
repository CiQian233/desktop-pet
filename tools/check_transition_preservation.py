"""Prove that transition work inserted frames without altering selected poses.

The baseline contains hashes of the pre-transition export. Every old native and
6x source frame must occur in the same order in the new animation; animations
that were not edited must remain exactly unchanged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "art" / "sprites" / "chibi-hd"
NATURAL_KEYS = {"stretch", "groom", "scratch", "lieDown", "roll", "greet", "wakeUp"}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", default=str(ROOT / "dist" / "transition-before-hashes.json"))
    parser.add_argument("--output", default=str(ROOT / "dist" / "transition-check" / "preservation.json"))
    args = parser.parse_args()
    baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
    meta = json.loads((OUT / "meta.json").read_text(encoding="utf-8"))
    report = {"animations": {}, "failures": [], "totals": {}}
    preserved = 0
    baseline_total = 0
    for key, old_hashes in baseline["animations"].items():
        baseline_total += len(old_hashes)
        count = meta["anims"][key]["count"]
        native = [digest(OUT / f"{key}_{i}@1x.png") for i in range(count)]
        source = [digest(OUT / f"{key}_{i}.png") for i in range(count)]
        mapping: list[int] = []
        failures: list[str] = []
        cursor = 0
        for old_index, old_hash in enumerate(old_hashes):
            found = None
            for new_index in range(cursor, len(native)):
                if native[new_index] != old_hash:
                    continue
                old_source = baseline["files"][f"{key}_{old_index}.png"]
                if source[new_index] == old_source:
                    found = new_index
                    break
            if found is None:
                failures.append(f"{key}_{old_index}: selected native/source pose not preserved")
            else:
                mapping.append(found)
                cursor = found + 1
                preserved += 1
        if key not in NATURAL_KEYS and len(native) != len(old_hashes):
            failures.append(f"{key}: non-natural animation frame count changed")
        report["animations"][key] = {
            "oldFrames": len(old_hashes), "newFrames": len(native),
            "insertedFrames": len(native) - len(old_hashes),
            "oldToNewIndices": mapping, "failures": failures,
        }
        report["failures"].extend(failures)
    report["totals"] = {
        "baselineFrames": baseline_total,
        "preservedNativeAndSourceFrames": preserved,
        "currentFrames": sum(anim["count"] for anim in meta["anims"].values()),
        "insertedFrames": sum(anim["count"] for anim in meta["anims"].values()) - baseline_total,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"totals": report["totals"], "failures": report["failures"], "report": str(output)},
                     ensure_ascii=False, indent=2))
    return 1 if report["failures"] or preserved != baseline_total else 0


if __name__ == "__main__":
    raise SystemExit(main())
