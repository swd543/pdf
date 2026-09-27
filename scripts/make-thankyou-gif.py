#!/usr/bin/env python3
"""Generate public/thank-you.gif — the pixel-art placeholder shown in ad
slots until AdSense is configured (see src/components/AdSlot.tsx).

A self-contained "sticker" in classic AdSense leaderboard proportions
(720x90, i.e. 728x90): a happy waving character, big "THANK YOU!" text,
a pulsing heart and twinkling sparkles. Cream background + ink border so
it reads on both the light and dark themes (a transparent GIF would
vanish on dark). 6-frame loop.

Run:  python3 scripts/make-thankyou-gif.py   (needs Pillow)
"""
import os

from PIL import Image

SCALE = 3
W, H = 240, 30  # logical grid → 720x90

CREAM = (0xFF, 0xF8, 0xEE)
INK = (0x1A, 0x1A, 0x1E)
CORAL = (0xFF, 0x6B, 0x45)
GOLD = (0xE0, 0xB1, 0x5C)

FONT = {
    "T": "11111|00100|00100|00100|00100|00100|00100",
    "H": "10001|10001|11111|10001|10001|10001|10001",
    "A": "01110|10001|11111|10001|10001|10001|10001",
    "N": "10001|11001|10101|10011|10001|10001|10001",
    "K": "10001|10010|11100|11100|11100|10010|10001",
    " ": "00000|00000|00000|00000|00000|00000|00000",
    "Y": "10001|10001|01010|00100|00100|00100|00100",
    "O": "01110|10001|10001|10001|10001|10001|01110",
    "U": "10001|10001|10001|10001|10001|10001|01110",
    "!": "00100|00100|00100|00100|00100|00000|00100",
}

# Happy character, 14x13. C=body, D=ink, G=gold. Eyes 2x2 at cols 3-4 / 9-10.
CHAR_OPEN = [
    "...CCCCCCCC...",
    "..CCCCCCCCCC..",
    ".CCCCCCCCCCC..",
    ".CCCCCCCCCCC..",
    ".CCDDCCCCDDCC.",
    ".CCDDCCCCDDCC.",
    ".CGCCCCCCCCGC.",
    ".CCCCDDDDDDCC..",
    ".CCCCCDDDDCC..",
    ".CCCCCCCCCCC..",
    ".CCCCCCCCCCC..",
    ".CC.CCCCC.CCC.",
    "....CC..CC....",
]
# Blink: eyes collapse to their bottom row.
CHAR_BLINK = [
    "...CCCCCCCC...",
    "..CCCCCCCCCC..",
    ".CCCCCCCCCCC..",
    ".CCCCCCCCCCC..",
    ".CCCCCCCCCCC..",
    ".CCDDCCCCDDCC.",
    ".CGCCCCCCCCGC.",
    ".CCCCDDDDDDCC..",
    ".CCCCCDDDDCC..",
    ".CCCCCCCCCCC..",
    ".CCCCCCCCCCC..",
    ".CC.CCCCC.CCC.",
    "....CC..CC....",
]

HEART_S = [".11.11.", "1111111", "1111111", ".11111.", "..111..", "...1..."]
HEART_L = [
    ".111.111.",
    "111111111",
    "111111111",
    "111111111",
    ".1111111.",
    "..11111..",
    "...111...",
]
SPARK_5 = ["..1..", ".111.", "11111", ".111.", "..1.."]
SPARK_3 = [".1.", "111", ".1."]

CHAR_X = 12
CHAR_Y = 8


def put(img: Image.Image, ox: int, oy: int, rows, palette, font: int = 1) -> None:
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in palette:
                color = palette[ch]
                for dx in range(SCALE * font):
                    for dy in range(SCALE * font):
                        img.putpixel(
                            ((ox + x * font) * SCALE + dx, (oy + y * font) * SCALE + dy),
                            color,
                        )


def put_block(img: Image.Image, ox: int, oy: int, w: int, h: int, color) -> None:
    for dx in range(w):
        for dy in range(h):
            img.putpixel(((ox + dx) * SCALE, (oy + dy) * SCALE), color)


def border(img: Image.Image) -> None:
    for x in range(W * SCALE):
        img.putpixel((x, 0), INK)
        img.putpixel((x, H * SCALE - 1), INK)
    for y in range(H * SCALE):
        img.putpixel((0, y), INK)
        img.putpixel((W * SCALE - 1, y), INK)


def frame(
    char: list[str],
    bob: int,
    arm_dy: int,
    heart: str,
    sp_a: str,
    sp_b: str,
    sp_c: str,
) -> Image.Image:
    img = Image.new("RGB", (W * SCALE, H * SCALE), CREAM)
    border(img)

    # Character (bobs up/down by 1 logical px) + waving arm (2x2 block
    # hugging the right edge of the body).
    cy = CHAR_Y + bob
    put(img, CHAR_X, cy, char, {"C": CORAL, "D": INK, "G": GOLD})
    put_block(img, CHAR_X + 13, cy + arm_dy, 2, 2, CORAL)

    # Big "THANK YOU!" (2x font), vertically centred.
    text = "THANK YOU!"
    glyph_w, gap = 5 * 2, 2
    tx = 56
    ty = 8
    for i, ch in enumerate(text):
        put(img, tx + i * (glyph_w + gap), ty, FONT[ch].split("|"), {"1": INK}, font=2)

    # Pulsing heart, centred.
    rows = HEART_S if heart == "S" else HEART_L
    put(img, 190, 11 if heart == "S" else 10, rows, {"1": CORAL})

    # Twinkling sparkles.
    if sp_a:
        put(img, 180, 4, SPARK_5 if sp_a == "5" else SPARK_3, {"1": GOLD})
    if sp_b:
        put(img, 218, 19, SPARK_5 if sp_b == "5" else SPARK_3, {"1": GOLD})
    if sp_c:
        put(img, 228, 5, SPARK_3, {"1": GOLD})
    return img


frames = [
    frame(CHAR_OPEN, 0, 2, "S", "5", "", ""),
    frame(CHAR_OPEN, 1, 5, "L", "", "5", ""),
    frame(CHAR_BLINK, 0, 8, "S", "", "", "3"),
    frame(CHAR_OPEN, 1, 2, "L", "", "", ""),
    frame(CHAR_OPEN, 0, 5, "S", "3", "", ""),
    frame(CHAR_OPEN, 1, 8, "L", "", "", ""),
]

out = "public/thank-you.gif"
frames[0].save(
    out,
    save_all=True,
    append_images=frames[1:],
    duration=200,
    loop=0,
    optimize=True,
)
print(f"wrote {out} ({os.path.getsize(out)} bytes, {len(frames)} frames)")
