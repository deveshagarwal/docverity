#!/usr/bin/env python3
"""Render docs/demo.gif: a terminal-styled animation of docverity catching drift.

No TTY or screen recorder needed; frames are drawn with Pillow. Run:
    python3 scripts/render_demo_gif.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

BG = (30, 33, 39)
FG = (216, 216, 216)
DIM = (127, 132, 142)
RED = (224, 108, 117)
GREEN = (152, 195, 121)
CYAN = (86, 182, 194)
YELLOW = (229, 192, 123)

FONT_PATH = "/System/Library/Fonts/Menlo.ttc"
SIZE = 26
reg = ImageFont.truetype(FONT_PATH, SIZE, index=0)
try:
    bold = ImageFont.truetype(FONT_PATH, SIZE, index=1)
except Exception:
    bold = reg

CW = reg.getlength("m")
LH = SIZE + 12
PAD = 28

# Each row is a list of (text, color, bold) segments.
ROWS = [
    [("# taskwarden - its README drifted from the code. does docverity catch it?", DIM, False)],
    [],
    [("$ ", GREEN, True), ("npx docverity", FG, False)],  # row 2: the command
    [],
    [("× 3 doc claims drifted from the code:", RED, True)],
    [],
    [("  ● ", RED, False), ("README.md:7", CYAN, False), ("   --watch", FG, True)],
    [("      the CLI flag --watch is gone from the source - renamed or removed?", DIM, False)],
    [],
    [("  ● ", RED, False), ("README.md:8", CYAN, False), ("   TASKWARDEN_TOKEN", FG, True)],
    [("      that environment variable no longer appears in the code.", DIM, False)],
    [],
    [("  ● ", RED, False), ("README.md:9", CYAN, False), ("   src/server.ts", FG, True)],
    [("      no such file - the code moved it to src/app.ts.", DIM, False)],
    [],
    [("1 ok · 3 drifted", DIM, False), ("   exit 1 - fails CI ×", RED, False)],
]

CMD_ROW = 2
CMD_TEXT = "npx docverity"
OUTPUT_START = 3  # rows 3.. are revealed progressively

def row_width(row):
    return sum(len(t) for t, _, _ in row)

WIDTH = int(PAD * 2 + max(row_width(r) for r in ROWS) * CW) + 4
HEIGHT = int(PAD * 2 + len(ROWS) * LH)

def render(cmd_chars, out_rows, cursor):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    d = ImageDraw.Draw(img)
    for i, row in enumerate(ROWS):
        if i > CMD_ROW and i >= OUTPUT_START and i >= OUTPUT_START + out_rows:
            continue
        y = PAD + i * LH
        x = PAD
        if i == CMD_ROW:
            # prompt, then the typed portion of the command
            d.text((x, y), "$ ", font=bold, fill=GREEN)
            x += 2 * CW
            typed = CMD_TEXT[:cmd_chars]
            d.text((x, y), typed, font=reg, fill=FG)
            x += len(typed) * CW
            if cursor:
                d.rectangle([x, y + 3, x + CW - 2, y + SIZE], fill=FG)
            continue
        for text, color, is_bold in row:
            d.text((x, y), text, font=(bold if is_bold else reg), fill=color)
            x += len(text) * CW
    return img

frames, durations = [], []

def add(img, ms):
    frames.append(img)
    durations.append(ms)

# 1) blank prompt with cursor
add(render(0, 0, True), 500)
# 2) type the command
for k in range(1, len(CMD_TEXT) + 1):
    add(render(k, 0, True), 60)
# 3) brief pause on the full command
add(render(len(CMD_TEXT), 0, False), 350)
# 4) reveal output rows one at a time
n_out = len(ROWS) - OUTPUT_START
for k in range(1, n_out + 1):
    add(render(len(CMD_TEXT), k, False), 150)
# 5) hold the result
add(render(len(CMD_TEXT), n_out, False), 2400)

os.makedirs("docs", exist_ok=True)
out = "docs/demo.gif"
frames[0].save(
    out,
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    disposal=2,
    optimize=True,
)
print(f"wrote {out}  ({WIDTH}x{HEIGHT}, {len(frames)} frames)")
