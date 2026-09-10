"""Prove the facing judgement works at the artwork level, independent of the app.

The renderer mirrors the sprite when the cat faces right. Mirroring must move the
drawn pixels' horizontal centre of mass; if that number were the same for the
native and mirrored images, no pixel-based probe could ever detect a facing bug.
This prints the numbers for a few frames so the probe's premise is checked
against the art itself rather than against the running program.
"""
from PIL import Image, ImageOps

def profile_rows(im):
    """per-row horizontal centre of mass, normalised to 0..1 (0 = empty row)"""
    px = im.load()
    w, h = im.size
    rows = []
    for y in range(h):
        s = n = 0
        for x in range(w):
            if px[x, y][3] > 24:
                s += x
                n += 1
        rows.append(s / n / w if n else 0.0)
    return rows

def distance(a, b):
    return sum(abs(x - y) for x, y in zip(a, b) if x and y)

for name in ['sit_0', 'walk_0', 'walk_3', 'carry_0', 'angry_0']:
    art = Image.open(f'art/sprites/chibi-hd/{name}.png').convert('RGBA')
    native = profile_rows(art)
    mirrored = profile_rows(ImageOps.mirror(art))
    dn = distance(native, native)
    dm = distance(mirrored, native)
    print(f'{name:9s} distance(native)={dn:7.3f}  distance(mirrored)={dm:7.3f}  '
          f'-> judgeable: {dm > dn + 1}')
