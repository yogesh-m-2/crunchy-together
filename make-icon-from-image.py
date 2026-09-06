#!/usr/bin/env python3
"""
Otaku Sync — build icon sizes from an existing logo image.

    python3 make-icon-from-image.py path/to/logo.png

Trims the surrounding whitespace, squares the artwork up, places it on a
background, and exports every size Chrome needs. Small sizes are cropped
tighter to the centre of the mark, because fine detail turns to mush at 16px.

Outputs: icon-16/32/48/128.png and icon-512.png, in two background variants.
"""

import sys
from PIL import Image, ImageDraw, ImageChops

LIGHT = (255, 255, 255, 255)
DARK = (23, 27, 36, 255)          # matches the extension panel


def trim(img, bg_tolerance=12):
    """Crop away a uniform border (usually white) around the artwork."""
    rgb = img.convert("RGB")
    corner = rgb.getpixel((0, 0))
    bg = Image.new("RGB", rgb.size, corner)
    diff = ImageChops.difference(rgb, bg).convert("L")
    mask = diff.point(lambda p: 255 if p > bg_tolerance else 0)
    box = mask.getbbox()
    return img.crop(box) if box else img


def square(img, bg, pad_ratio=0.10):
    """Centre the artwork on a square canvas with a little breathing room."""
    w, h = img.size
    side = int(max(w, h) * (1 + pad_ratio * 2))
    canvas = Image.new("RGBA", (side, side), bg)
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img if img.mode == "RGBA" else None)
    return canvas


def rounded(img, radius_ratio=0.22):
    """Round the corners so it doesn't look like a pasted rectangle."""
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def zoom_centre(img, factor=0.62):
    """Crop toward the middle — keeps the mark readable at tiny sizes."""
    w, h = img.size
    side = int(min(w, h) * factor)
    left = (w - side) // 2
    top = int((h - side) * 0.38)      # bias upward: faces sit above centre
    return img.crop((left, top, left + side, top + side))


def build(path, bg, suffix):
    src = Image.open(path).convert("RGBA")
    art = trim(src)

    big = rounded(square(art, bg))
    tight = rounded(square(zoom_centre(art), bg, pad_ratio=0.06))

    for s in (512, 128, 48, 32, 16):
        # Below 48px, use the zoomed-in crop.
        master = big if s >= 48 else tight
        out = master.resize((s, s), Image.LANCZOS)
        name = f"icon-{s}{suffix}.png"
        out.save(name, "PNG", optimize=True)
        print(f"wrote {name}  ({s}x{s})")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    path = sys.argv[1]
    build(path, LIGHT, "-light")
    build(path, DARK, "-dark")


if __name__ == "__main__":
    main()
