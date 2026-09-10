"""Repair a source file whose non-ASCII text was destroyed by a PowerShell round-trip.

WHY THIS EXISTS
---------------
Windows PowerShell 5.1 `Get-Content` decodes files with the *system ANSI codepage*
(GBK on a Chinese Windows), and `Set-Content -Encoding UTF8` writes them back as
UTF-8. Round-tripping a UTF-8 source file through that pair turns every Chinese
string into GBK mojibake, loses the bytes that have no GBK mapping (they become
'?') and can eat the closing quote of a string literal. That happened to
src/main/main.ts in session 8: 17 lines were destroyed, TypeScript reported
"Unterminated string literal", and the compiled main process failed to load.

The damaged file also contained '?' characters, so the original bytes CANNOT be
recovered by re-decoding. The repair therefore never guesses at the mojibake:
each damaged line is matched by its stable ASCII skeleton and rewritten whole,
with the correct text supplied from knowledge of the UI.

USAGE
-----
    python tools/repair-strings.py --scan FILE     # print ASCII skeletons of the
                                                   # lines that contain non-ASCII
    python tools/repair-strings.py --apply FILE     # apply the repair table below

--scan is the tool to reach for first: it shows exactly which lines are damaged
and what their surviving structure looks like, which is what a new repair rule has
to match. A rule that does not hit exactly once aborts the whole run.

Guarding against a repeat: scripts/check-text.mjs runs in `npm run build` and
fails on a BOM, U+FFFD, this kind of mojibake, or an unterminated single-quoted
string. scripts/check-text-negative.mjs proves that guard actually fires.
"""
import argparse
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Repair table: (regex over the line, replacement, expected hits, description)
#
# The regexes deliberately only describe ASCII: they lock onto the surrounding
# code (`['rest', '...'],`, `label: '...',`, `tray.setToolTip('...')`) and let the
# damaged bytes be whatever they are. Replacement strings are NOT raw so that the
# \\uXXXX escapes are decoded before re.sub sees them.
# ---------------------------------------------------------------------------
DEFAULT_RULES = [
    (r"^(\s*\['rest',\s*')[^']*('\],?)$", "\g<1>\u539f\u5730\u5f85\u673a\g<2>", 1, 'mode rest'),
    (r"^(\s*\['roam',\s*')[^']*('\],?)$", "\g<1>\u81ea\u7531\u8d70\u52a8\g<2>", 1, 'mode roam'),
    (r"^(\s*\['follow',\s*')[^']*('\],?)$", "\g<1>\u8ddf\u7740\u9f20\u6807\g<2>", 1, 'mode follow'),
    (r"^(\s*\['slow',\s*')[^']*\?\],$", "\g<1>\u6162'],", 1, 'speed slow'),
    (r"^(\s*\['normal',\s*')[^']*\?\],$", "\g<1>\u4e2d'],", 1, 'speed normal'),
    (r"^(\s*\['fast',\s*')[^']*\?\],$", "\g<1>\u5feb'],", 1, 'speed fast'),
    (r"^(\s*\{ label: cfg\.paused \? ')[^']*(' : ')[^']*('.*)$",
     "\g<1>\u7ee7\u7eed\u52a8\u4f5c\g<2>\u6682\u505c\u52a8\u4f5c\g<3>", 1, 'pause / resume'),
    (r"^(\s*label: ')[^']*(',\s*)$", "\g<1>\u884c\u4e3a\u6a21\u5f0f\g<2>", 1, '\u884c\u4e3a\u6a21\u5f0f'),
    (r"^(\s*label: ')[^']*(',\s*)$", "\g<1>\u8d70\u8def\u901f\u5ea6\g<2>", 1, '\u8d70\u8def\u901f\u5ea6'),
    (r"^(\s*label: ')[^']*(',\s*)$", "\g<1>\u663e\u793a\u500d\u7387\g<2>", 1, '\u663e\u793a\u500d\u7387'),
    (r"^(\s*label: ')[^']*\?\s*,?\s*$", "\g<1>\u5f00\u673a\u81ea\u542f',", 1, '\u5f00\u673a\u81ea\u542f'),
    (r"^(\s*label: ')[^']*(',\s*)$", "\g<1>\u7a97\u53e3\u7f6e\u9876\g<2>", 1, '\u7a97\u53e3\u7f6e\u9876'),
    (r"^(\s*label: ')[^']*(',\s*)$", "\g<1>\u79fb\u5230\u4e3b\u663e\u793a\u5668\g<2>", 1,
     '\u79fb\u5230\u4e3b\u663e\u793a\u5668'),
    (r"^(\s*\{ label: ')[^']*,(\s*click: \(\) => patch\(\{ x: null, y: null, facing: )\d( \}\) \},)$",
     "\g<1>\u56de\u5230\u53f3\u4e0b\u89d2',\g<2>-1\g<3>", 1, '\u56de\u5230\u53f3\u4e0b\u89d2'),
    (r"^(\s*\{ label: ')[^']*,(\s*click: \(\) => app\.quit\(\) \},)$",
     "\g<1>\u9000\u51fa',\g<2>", 1, '\u9000\u51fa'),
]

# Lines that need per-line structural work (not a simple regex) are handled here:
# the tray tooltip is replaced between its first pair of quotes.
TOOLTIP_MARKER = 'tray.setToolTip('
TOOLTIP_TEXT = "\u684c\u5ba0\u732b\u54aa \u00b7 \u5de6\u952e\u6478\u5934 / \u53f3\u952e\u83dc\u5355"


def non_ascii(line: str) -> bool:
    return any(ord(ch) > 0x7E for ch in line)


def scan(path: Path) -> None:
    """Print the ASCII skeleton of every line containing non-ASCII text."""
    lines = path.read_text(encoding='utf-8').split('\n')
    print(f'{path}: {len(lines)} lines')
    shown = 0
    for i, line in enumerate(lines, start=1):
        if not non_ascii(line):
            continue
        shown += 1
        skeleton = ''.join(ch if 0x20 <= ord(ch) <= 0x7E else '.' for ch in line.rstrip())
        quotes = line.count("'")
        # ASCII-only output: the Windows console codepage cannot print the damage
        print(f'{i:5d} | quotes={quotes} | {skeleton.strip()}')
    print(f'{shown} line(s) contain non-ASCII text')


def apply_repairs(path: Path) -> int:
    text = path.read_text(encoding='utf-8')
    lines = text.split('\n')

    # Rules are applied in file order: each consumes the first still-unclaimed
    # matching line at or after the previous rule's line, so two rules that share
    # a pattern cannot fight over the same line.
    used = [0] * len(DEFAULT_RULES)
    applied_at = [0] * len(DEFAULT_RULES)
    cursor = 0
    for r, (pattern, replacement, _expect, _label) in enumerate(DEFAULT_RULES):
        for i in range(cursor, len(lines)):
            if re.match(pattern, lines[i]):
                lines[i] = re.sub(pattern, replacement, lines[i])
                used[r] += 1
                applied_at[r] = i + 1
                cursor = i + 1
                break

    tooltip_hits = 0
    for i, line in enumerate(lines):
        if TOOLTIP_MARKER not in line:
            continue
        start = line.index("'")
        end = line.index("'", start + 1)
        lines[i] = line[:start + 1] + TOOLTIP_TEXT + line[end:]
        tooltip_hits += 1

    problems = [
        'rule %d (%s) matched %d time(s), expected %d'
        % (r + 1, DEFAULT_RULES[r][3], used[r], DEFAULT_RULES[r][2])
        for r in range(len(DEFAULT_RULES))
        if used[r] != DEFAULT_RULES[r][2]
    ]
    if tooltip_hits != 1:
        problems.append('%s: found %d lines, expected 1' % (TOOLTIP_MARKER, tooltip_hits))
    if problems:
        print('refusing to write:', file=sys.stderr)
        for p in problems:
            print('  ' + p, file=sys.stderr)
        return 1

    path.write_text('\n'.join(lines), encoding='utf-8', newline='')
    for r in range(len(DEFAULT_RULES)):
        print('  line %-4d %s' % (applied_at[r], DEFAULT_RULES[r][3]))
    print('  line %-4d tray tooltip' % 0)
    print(f'repaired {sum(used) + tooltip_hits} lines in {path}')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file', type=Path, help='source file to scan or repair')
    ap.add_argument('--scan', action='store_true', help='print ASCII skeletons instead of repairing')
    ap.add_argument('--apply', action='store_true', help='apply the built-in repair table')
    args = ap.parse_args()

    if not args.file.exists():
        print('no such file: %s' % args.file, file=sys.stderr)
        return 2
    if args.scan:
        scan(args.file)
        return 0
    if args.apply:
        return apply_repairs(args.file)
    ap.print_help()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
