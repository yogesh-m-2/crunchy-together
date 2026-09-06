#!/usr/bin/env python3
"""
Otaku Sync — turn raw screenshots into Chrome Web Store sizes.

    python3 make-screenshots.py shot1.png shot2.png ...

The Web Store wants 1280x800 (or 640x400). Source screenshots are usually
wider than that ratio, so this scales to the target height and then trims
from the LEFT — the party panel lives on the right edge and must survive.

Outputs: shot-01-1280x800.png, shot-01-640x400.png, and so on.
"""

import sys
from PIL import Image

TARGETS = [(1280, 800), (640, 400)]
PAD = (16, 19, 26, 255)   # matches the panel's darkest tone


def fit(img, tw, th):
    """Scale to cover the target, then crop from the left and centre vertically."""
    w, h = img.size
    scale = max(tw / w, th / h)
    new = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    nw, nh = new.size

    left = nw - tw           # keep the right edge: that's where the panel is
    top = max(0, (nh - th) // 2)
    if left < 0:             # source narrower than target: pad instead of crop
        canvas = Image.new("RGBA", (tw, th), PAD)
        canvas.paste(new.convert("RGBA"), ((tw - nw) // 2, (th - nh) // 2))
        return canvas
    return new.crop((left, top, left + tw, top + th))


def main():
    files = sys.argv[1:]
    if not files:
        print(__doc__)
        sys.exit(1)
    for i, path in enumerate(files, 1):
        src = Image.open(path).convert("RGB")
        for tw, th in TARGETS:
            out = fit(src, tw, th).convert("RGB")
            name = f"shot-{i:02d}-{tw}x{th}.png"
            out.save(name, "PNG", optimize=True)
            print(f"wrote {name}  (from {path.split('/')[-1]} {src.size[0]}x{src.size[1]})")


if __name__ == "__main__":
    main()
