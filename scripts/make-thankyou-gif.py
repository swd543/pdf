#!/usr/bin/env python3
"""Generate public/thank-you.gif — the pixel-art placeholder shown in ad
slots until AdSense is configured (see src/components/AdSlot.tsx).

A self-contained "sticker": cream background + ink border so it reads on
both the light and dark themes (a transparent GIF would vanish on dark).
4-frame loop: the heart pulses and two gold sparkles twinkle in turn.

Run:  python3 scripts/make-thankyou-gif.py   (needs Pillow)
"""
import os

from PIL import Image

SCALE = 2
W, H = 96, 36  # logical grid


def _rgb(h: str) -> tuple[int, int, int]:
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


CREAM = _rgb("#FFF8EE")
INK = _rgb("#1A1A1E")
CORAL = _rgb("#FF6B45")
GOLD = _rgb("#E0B15C")

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


def put(img: Image.Image, ox: int, oy: int, rows: list[str], color) -> None:
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == "1":
                for dx in range(SCALE):
                    for dy in range(SCALE):
                        img.putpixel(((ox + x) * SCALE + dx, (oy + y) * SCALE + dy), color)


def frame(heart: str, sp_a: str, sp_b: str) -> Image.Image:
    img = Image.new("RGB", (W * SCALE, H * SCALE), CREAM)
    # ink border (1 logical px)
    for x in range(W * SCALE):
        img.putpixel((x, 0), INK)
        img.putpixel((x, H * SCALE - 1), INK)
    for y in range(H * SCALE):
        img.putpixel((0, y), INK)
        img.putpixel((W * SCALE - 1, y), INK)
    # "THANK YOU!" centered, rows y=5..11
    text = "THANK YOU!"
    tx = (W - (len(text) * 6 - 1)) // 2  # 5-wide glyphs, 1px gap
    for i, ch in enumerate(text):
        put(img, tx + i * 6, 5, FONT[ch].split("|"), INK)
    # pulsing heart, centered
    rows = HEART_S if heart == "S" else HEART_L
    put(img, (W - len(rows[0])) // 2, 18, rows, CORAL)
    # twinkling sparkles
    if sp_a:
        put(img, 8, 4, SPARK_5 if sp_a == "5" else SPARK_3, GOLD)
    if sp_b:
        put(img, 82, 19, SPARK_5 if sp_b == "5" else SPARK_3, GOLD)
    return img


frames = [
    frame("S", "5", ""),
    frame("L", "", "5"),
    frame("S", "", "3"),
    frame("L", "3", ""),
]

out = "public/thank-you.gif"
frames[0].save(
    out,
    save_all=True,
    append_images=frames[1:],
    duration=240,
    loop=0,
    optimize=True,
)
print(f"wrote {out} ({os.path.getsize(out)} bytes, {len(frames)} frames)")
