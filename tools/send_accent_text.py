"""Render the firmware's GFX font into two BMP planes and send accent text."""
import argparse
import os
from pathlib import Path
import re
import struct
import requests

parser = argparse.ArgumentParser()
parser.add_argument("text")
parser.add_argument("--controller", default=os.environ.get("CHROMA_CONTROLLER", "http://chroma.local"))
parser.add_argument("--id", type=int, default=123)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
font = (root / "firmware/RFV3/font.h").read_text()
bitmap_source = font.split("Dialog_bold_40Bitmaps[] PROGMEM = {", 1)[1].split("};", 1)[0]
bitmap = bytes(int(value, 16) for value in re.findall(r"0x([0-9a-fA-F]{2})", bitmap_source))
glyph_source = font.split("Dialog_bold_40Glyphs[] PROGMEM = {", 1)[1].split("};", 1)[0]
glyphs = [tuple(map(int, values)) for values in re.findall(r"\{\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}", glyph_source)]
if not args.text or any(not 32 <= ord(c) <= 125 for c in args.text):
    raise SystemExit("Use printable ASCII supported by the firmware font.")
width, height = 640, 384
stride = width // 8
cursor = 0
points = []
for character in args.text:
    offset, gw, gh, advance, dx, dy = glyphs[ord(character) - 32]
    for y in range(gh):
        for x in range(gw):
            bit = y * gw + x
            if bitmap[offset + bit // 8] & (0x80 >> (bit % 8)):
                points.append((cursor + dx + x, dy + y))
    cursor += advance
if not points:
    raise SystemExit("The text has no visible pixels.")
xmin, xmax = min(x for x, _ in points), max(x for x, _ in points)
ymin, ymax = min(y for _, y in points), max(y for _, y in points)
scale = min(2, (width - 40) // (xmax - xmin + 1), (height - 40) // (ymax - ymin + 1))
if scale < 1:
    raise SystemExit("Text is too wide for the display.")
left = (width - (xmax - xmin + 1) * scale) // 2
top = (height - (ymax - ymin + 1) * scale) // 2
black = bytearray(b"\xff" * (stride * height))
accent = bytearray(black)
for x, y in points:
    for sy in range(scale):
        for sx in range(scale):
            px, py = left + (x - xmin) * scale + sx, top + (y - ymin) * scale + sy
            accent[py * stride + px // 8] &= ~(0x80 >> (px % 8))


def bmp(pixels):
    pixels = b"".join(pixels[y * stride:(y + 1) * stride] for y in reversed(range(height)))
    header = struct.pack("<2sIHHI", b"BM", 62 + len(pixels), 0, 0, 62)
    header += struct.pack("<IiiHHIIiiII", 40, width, height, 1, 1, 0, len(pixels), 2835, 2835, 2, 0)
    return header + b"\x00\x00\x00\x00\xff\xff\xff\x00" + pixels


for name, pixels in (("accent-base.bmp", black), ("accent-text.bmp", accent)):
    content = bmp(pixels)
    (root / "artifacts" / name).write_bytes(content)

# Build the stock uncompressed command on the host. This avoids doing two
# SPIFFS-backed arithmetic encodes in the controller's HTTP callback.
pixels = bytes(black + accent)
header = bytearray(32)
header[:2] = b"\x83\x19"
struct.pack_into("<HHH", header, 3, width, height, len(pixels))
header[22] = (-sum(pixels)) & 255
header[23] = 0  # no compression
header[26:30] = b"\x21\x84\x80\x00"  # two color planes, large addressing
struct.pack_into(">H", header, 30, len(pixels))
command = bytes(header) + pixels + b"\x85\x05\x08\x00\x00\x01\x01"
(root / "artifacts" / "accent-text.bin").write_bytes(command)
response = requests.post(args.controller + "/edit", auth=("admin", "admin"),
                         files={"data": ("/accent-text.bin", command, "application/octet-stream")}, timeout=15)
response.raise_for_status()
print(response.text, flush=True)
response = requests.post(args.controller + "/set_file",
                         params={"id": args.id, "file": "accent-text.bin"}, timeout=20)
response.raise_for_status()
print(response.text)
if not response.text.startswith("OK cmd to display"):
    raise SystemExit("Controller did not accept the image.")
