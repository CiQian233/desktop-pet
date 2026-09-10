"""The pet's master palette.

Base colours sampled from the owner's cat photos (tools/extract_palette.py),
then hand-calibrated so the fur reads correctly at 1px scale: photo medians of
the orange patches come out desaturated because they average in shadow and
wallpaper, so chroma is restored here.
"""

from __future__ import annotations

PALETTE: dict[str, tuple[int, int, int]] = {
    # --- white fur (chest, muzzle, paws, blaze) -------------------------
    "W":  (243, 239, 232),   # lit white
    "w":  (223, 218, 209),   # base white
    "w2": (200, 193, 182),   # shadow white
    "w3": (170, 161, 150),   # deep shadow
    # --- orange / ginger patches (forehead, ears, back) -----------------
    "O":  (191, 131, 66),    # lit ginger
    "o":  (158, 100, 48),    # base ginger
    "o2": (118, 71, 34),     # ginger shadow
    # --- ink-black patches ---------------------------------------------
    "K":  (58, 49, 40),      # lit black-brown
    "k":  (38, 32, 26),      # base black
    "i":  (24, 20, 17),      # deep black / pupil
    "k2": (24, 20, 17),      # alias kept for older maps
    # --- face ----------------------------------------------------------
    "E":  (152, 168, 92),    # iris  (yellow-green)
    "D":  ( 96, 110, 58),    # iris shadow
    "A":  (216, 158, 66),    # iris amber, lit
    "a":  (178, 118, 44),    # iris amber, base
    "a2": (128, 80, 32),     # iris amber, shadow
    "P":  (214, 146, 142),   # nose
    "p":  (219, 160, 152),   # inner ear
    "H":  (250, 250, 244),   # eye highlight
    # --- line work -----------------------------------------------------
    "L":  (30, 25, 21),      # outline
    "S":  (110, 96, 84),     # soft shading / ground contact
    # --- cosmetic, drawn *after* the outline so it never gets rimmed -----
    "X":  (214, 206, 194),   # whisker
}

# transparent
EMPTY = "."

# Characters that may appear in a sprite map, mapped to palette keys.
CHARS = set(PALETTE) | {EMPTY}


def rgb(key: str) -> tuple[int, int, int]:
    return PALETTE[key]


def hexs(key: str) -> str:
    return "#%02X%02X%02X" % PALETTE[key]


if __name__ == "__main__":
    for k, v in PALETTE.items():
        print(f"  {k:3s} {hexs(k)}  {v}")
