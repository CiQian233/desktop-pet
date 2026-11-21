"""Export review GIFs and an overview for the current natural animations."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / "art" / "sprites" / "chibi-hd"
OUT = ROOT / "preview" / "natural-transitions-v040"
KEYS = ["stretch", "groom", "scratch", "lieDown", "roll", "greet", "wakeUp"]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    meta = json.loads((SPRITES / "meta.json").read_text(encoding="utf-8"))
    preservation_path = ROOT / "dist" / "transition-check" / "preservation.json"
    preservation = json.loads(preservation_path.read_text(encoding="utf-8")) if preservation_path.exists() else {"animations": {}}
    overview = Image.new("RGB", (8 * 152 + 130, len(KEYS) * 164 + 28), "#f4f1ea")
    draw = ImageDraw.Draw(overview)
    for row, key in enumerate(KEYS):
        anim = meta["anims"][key]
        count = anim["count"]
        old_indices = set(preservation["animations"].get(key, {}).get("oldToNewIndices", []))
        frames = []
        for index in range(count):
            native = Image.open(SPRITES / f"{key}_{index}@1x.png").convert("RGBA")
            frame = Image.new("RGBA", native.size, "white")
            frame.alpha_composite(native)
            frames.append(frame.resize((228, 204), Image.Resampling.NEAREST).convert("RGB"))
        gif_path = OUT / f"{key}.gif"
        frames[0].save(gif_path, save_all=True, append_images=frames[1:],
                       duration=round(1000 / anim["fps"]), loop=0, disposal=2)
        draw.text((8, row * 164 + 62), key, fill="#302b28")
        samples = sorted({round(i * (count - 1) / 7) for i in range(8)})
        for column, index in enumerate(samples):
            native = Image.open(SPRITES / f"{key}_{index}@1x.png").convert("RGBA")
            tile = Image.new("RGBA", native.size, "white")
            tile.alpha_composite(native)
            tile = tile.resize((152, 136), Image.Resampling.NEAREST).convert("RGB")
            x = 130 + column * 152
            y = row * 164 + 20
            overview.paste(tile, (x, y))
            color = "#8a7f77" if index in old_indices else "#188a83"
            draw.rectangle((x, y, x + 151, y + 135), outline=color, width=2)
            draw.text((x + 5, y + 140), f"{index}{'' if index in old_indices else ' +'}", fill=color)
    draw.text((8, 6), "gray = selected key pose   teal/+ = inserted transition", fill="#5f554e")
    overview.save(OUT / "overview.png")
    print(json.dumps({"output": str(OUT), "gifs": len(KEYS), "overview": str(OUT / 'overview.png')}, ensure_ascii=False))


if __name__ == "__main__":
    main()
