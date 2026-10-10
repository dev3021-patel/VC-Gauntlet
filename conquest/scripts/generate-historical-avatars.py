#!/usr/bin/env python3
"""Render the historical-figure avatars into public/avatars/ as 256x256 PNGs.

Each sprite is a 16x16 pixel grid scaled 16x with a transparent background,
matching the existing avatar sprites. Standard library only: Party workers do
not ship Pillow. Run from the repository root:

    python3 scripts/generate-historical-avatars.py
"""

from __future__ import annotations

import pathlib
import struct
import zlib

SCALE = 16
OUTPUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "avatars"

PALETTE = {
    ".": None,
    "k": (36, 22, 52),  # outline and eyes
    "s": (255, 217, 184),  # light skin
    "b": (141, 90, 59),  # deep skin
    "r": (216, 67, 59),
    "m": (122, 35, 49),  # maroon
    "y": (255, 210, 74),  # gold
    "B": (59, 91, 216),  # blue
    "n": (34, 48, 94),  # navy
    "h": (27, 27, 34),  # black hair and cloth
    "o": (122, 74, 36),  # brown hair
    "f": (201, 163, 106),  # fur
    "c": (90, 168, 58),  # laurel
    "g": (76, 175, 80),  # leaf
    "G": (154, 160, 168),  # gray
    "l": (232, 232, 238),  # white hair
    "w": (244, 241, 234),  # white cloth
    "p": (142, 91, 216),  # purple
}

# Each sprite is 16 rows of left halves (8 cells) mirrored onto the right, so
# faces stay symmetric; ACCENTS then sets the few deliberately asymmetric cells.
BLANK = "........"
SPRITES: dict[str, list[str]] = {
    "cleopatra": [
        ".......k", "......ky", "....kkky", "...khhhh", "..khhhhh", "..kyyyyy", "..khssss", "..khssss",
        "..khskss", "..khssss", "..khsssr", "..khssss", "..khksss", "..khhkkk", "..khybyy", "..kyybyy",
    ],
    "julius-caesar": [
        BLANK, BLANK, "....kkkk", "...kcocc", "..kcoooo", "..kcosss", "..kossss", "..ksssss",
        "..ksskss", "..ksssss", "..kssssr", "...kssss", "....ksss", ".....kkk", "...kwwwr", "..kwwwwr",
    ],
    "genghis-khan": [
        "......kk", "....kkrr", "...krrrr", "..kfffff", "..kfffff", "..kfffff", "..khssss", "..khssss",
        "..khskss", "..khssss", "..khsshh", "...kshss", "....ksss", ".....kkk", "...krryy", "..krrryy",
    ],
    "joan-of-arc": [
        BLANK, BLANK, ".....kkk", "...kkooo", "..kooooo", "..koooos", "..kossss", "..kossss",
        "..koskss", "..kossss", "..kosssr", "..kossss", "..kkksss", ".....kkk", "...kGGwG", "..kGGGGw",
    ],
    "leonardo-da-vinci": [
        BLANK, BLANK, ".....kkk", "...kklll", "..klllll", "..kllsss", "..klssss", "..klssss",
        "..klskss", "..klssss", "..klslll", "..klllll", "...kllll", "....klll", "...kmmkl", "..kmmmmk",
    ],
    "william-shakespeare": [
        BLANK, BLANK, ".....kkk", "....ksss", "...kssss", "..kossss", "..kossss", "..kossss",
        "..koskss", "..kossss", "..kossoo", "..kossso", "..koksso", "..kwwkkk", "..kwwwww", "..knkwww",
    ],
    "galileo-galilei": [
        BLANK, BLANK, ".....kkk", "....ksss", "...kssss", "..kGssss", "..kGssss", "..kGssss",
        "..kGskss", "..kGssss", "..kGsGGG", "..kGGGGG", "...kGGGG", "....kGGG", "...khwwG", "..khhwww",
    ],
    "isaac-newton": [
        ".......k", "......kr", ".....krr", "...kkkrr", "..klllll", "..kllsss", "..klssss", "..klssss",
        "..klskss", "..klssss", "..klsssr", "..klssss", "..kllkss", "..kllkkk", "..klnnnw", "..knnnnw",
    ],
    "napoleon-bonaparte": [
        BLANK, BLANK, ".....kkk", "...kkhhh", ".kkhhhhh", "khhhhhhh", "..kkssss", "..khssss",
        "..khskss", "..ksssss", "..kssssr", "...kssss", "....ksss", ".....kkk", "..yknnnn", ".yyknnnw",
    ],
    "ada-lovelace": [
        BLANK, BLANK, ".....kkk", "...kooos", "..koooos", "..koosss", ".kooosss", ".koossss",
        ".kooskss", ".koossss", ".koosssr", "..koosss", "...kksss", ".....kkk", "...kwppp", "..kppppw",
    ],
    "abraham-lincoln": [
        "....kkkk", "....khhh", "....khhh", "....kGGG", "..kkkkkk", "...khsss", "..khssss", "..khssss",
        "..khskss", "..khssss", "..khsssr", "..khhsss", "...khhhh", "....khhh", "...khhwk", "..khhhhw",
    ],
    "harriet-tubman": [
        BLANK, BLANK, ".....kkk", "...kkrrw", "..krrwrr", "..krrrrr", "..kbbbbb", "..kbbbbb",
        "..kbbkbb", "..kbbbbb", "..kbbbbm", "...kbbbb", "....kbbb", ".....kkk", "...kGGww", "..kGGGGw",
    ],
}

# (row, column) -> colour for the details that must not be mirrored.
ACCENTS: dict[str, dict[tuple[int, int], str]] = {
    "isaac-newton": {(0, 8): "g"},  # the apple's leaf
    "napoleon-bonaparte": {(4, 6): "B", (4, 7): "w", (4, 8): "r"},  # tricolour cockade
    "harriet-tubman": {(2, 11): "r", (2, 12): "k", (3, 12): "r"},  # head-wrap knot
}


def _grid(name: str) -> list[str]:
    halves = SPRITES[name]
    if len(halves) != 16 or any(len(half) != 8 for half in halves):
        raise ValueError(f"{name} must be 16 rows of 8-cell halves")
    grid = [list(half + half[::-1]) for half in halves]
    for (row, column), colour in ACCENTS.get(name, {}).items():
        grid[row][column] = colour
    unknown = {cell for row in grid for cell in row} - PALETTE.keys()
    if unknown:
        raise ValueError(f"{name} uses unknown colours {sorted(unknown)}")
    return ["".join(row) for row in grid]


def _png(grid: list[str]) -> bytes:
    size = 16 * SCALE
    raw = bytearray()
    for row in grid:
        line = bytearray([0])
        for cell in row:
            colour = PALETTE[cell]
            pixel = bytes((*colour, 255)) if colour else b"\x00\x00\x00\x00"
            line += pixel * SCALE
        raw += bytes(line) * SCALE

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in SPRITES:
        (OUTPUT / f"{name}.png").write_bytes(_png(_grid(name)))
        print(f"wrote public/avatars/{name}.png")


if __name__ == "__main__":
    main()
