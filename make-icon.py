#!/usr/bin/env python3
"""
Otaku Sync — icon generator.

Draws an original mark: two play triangles side by side, the right one lagging
slightly behind and tinted, snapping into alignment with the left. Two people,
one frame.

    pip install Pillow
    python3 make-icon.py

Writes icon-16/32/48/128.png plus icon-512.png (handy for a store banner).
"""

from PIL import Image, ImageDraw

AMBER = (255, 176, 59, 255)      # brand background
INK = (25, 20, 0, 255)           # near-black, matches the panel accent text
GHOST = (25, 20, 0, 110)         # the "lagging" second triangle

# Everything is drawn at 512 and downsampled, which keeps small sizes crisp.
BASE = 512


def rounded_bg(size, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=AMBER)
    return img


def triangle(d, cx, cy, height, colour):
    """An equilateral-ish play triangle centred on (cx, cy)."""
    h = height
    w = h * 0.88
    d.polygon(
        [(cx - w / 2, cy - h / 2), (cx - w / 2, cy + h / 2), (cx + w / 2, cy)],
        fill=colour,
    )


def build(size=BASE, simple=False):
    """simple=True draws one bold triangle — at 16px two shapes merge into mush."""
    img = rounded_bg(size)
    d = ImageDraw.Draw(img)
    cy = size * 0.50

    if simple:
        triangle(d, size * 0.54, cy, size * 0.52, INK)
        return img

    h = size * 0.40
    # Left triangle sits ahead; right one trails behind and is lighter.
    triangle(d, size * 0.385, cy, h, INK)
    triangle(d, size * 0.655, cy, h, GHOST)
    return img


def main():
    detailed = build()
    simple = build(simple=True)
    for s in (512, 128, 48, 32, 16):
        # Below 48px the two-triangle mark stops being readable.
        master = detailed if s >= 48 else simple
        out = master.resize((s, s), Image.LANCZOS)
        name = f"icon-{s}.png"
        out.save(name, "PNG", optimize=True)
        print(f"wrote {name}  ({s}x{s})")


if __name__ == "__main__":
    main()
