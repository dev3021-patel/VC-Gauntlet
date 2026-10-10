#!/usr/bin/env python3
"""Redistribute trees and barricades evenly across backend/app/map-layout.json.

Issue #119: replaces every tree (T) and barricade (B) on open land with a
stratified, jittered layout at one moderate density across the whole map.
Run it again after any terrain change so the whole map receives the same treatment:

    python3 scripts/balance-map-obstacles.py

The output is deterministic for a given terrain and SEED. Placement only uses
open land ('.') whose surroundings are open land, keeps clear of bridges,
courtyard entrances, and every other obstacle, and the script fails rather than
write a layout that splits the walkable area. Afterwards, regenerate
terrain-contract.json (see .party/map.md).
"""
import json
import random
import sys
from collections import deque
from pathlib import Path

LAYOUT = Path(__file__).resolve().parent.parent / 'backend' / 'app' / 'map-layout.json'
SEED = 119
# One candidate per TILE x TILE square gives the uniform middle density.
TILE = 8
TREE_SHARE = 0.6
PAIR_SHARE = 0.5
# Chebyshev clearances, in movement blocks.
OBSTACLE_SPACING = 3
TERRAIN_CLEARANCE = 2
ROUTE_CLEARANCE = 4
# Existing obstacles kept in place as stable landmarks for tests and players.
LANDMARKS = {(4, 5): 'T', (44, 45): 'T', (48, 46): 'B', (49, 46): 'B', (48, 56): 'B', (49, 56): 'B', (70, 6): 'B'}
# The northern lane above the northwest fortress stays open, as it was before Issue #119.
# Gameplay tests (mobs, projectiles, lasers) use its long straight rows as their arena.
CLEAR_ZONES = [((1, 1), (56, 5))]
OBSTACLES = {'T', 'B'}
WALKABLE = {'.', '=', ':'}


def near(cell, cells, radius):
    x, y = cell
    return any((x + dx, y + dy) in cells for dx in range(-radius, radius + 1) for dy in range(-radius, radius + 1))


def connected(grid):
    cells = {(x, y) for y, row in enumerate(grid) for x, kind in enumerate(row) if kind in WALKABLE}
    start = next(iter(cells))
    seen, queue = {start}, deque([start])
    while queue:
        x, y = queue.popleft()
        for candidate in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if candidate in cells and candidate not in seen:
                seen.add(candidate)
                queue.append(candidate)
    return seen == cells


def balance(rows):
    grid = [list(row.replace('T', '.').replace('B', '.')) for row in rows]
    height, width = len(grid), len(grid[0])
    for (x, y), kind in LANDMARKS.items():
        if x < width and y < height:
            grid[y][x] = kind

    def kind(x, y):
        return grid[y][x] if 0 <= x < width and 0 <= y < height else '~'

    terrain = {(x, y) for y in range(height) for x in range(width) if kind(x, y) not in {'.', *OBSTACLES}}
    # Bridges and courtyard openings (courtyard tiles touching open land) need wide approaches.
    routes = {(x, y) for x, y in terrain if kind(x, y) == '=' or (
        kind(x, y) == ':' and any(kind(x + dx, y + dy) == '.' for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))))}
    placed = {(x, y) for y in range(height) for x in range(width) if kind(x, y) in OBSTACLES}

    def suitable(cell):
        x, y = cell
        if any(x1 <= x <= x2 and y1 <= y <= y2 for (x1, y1), (x2, y2) in CLEAR_ZONES):
            return False
        return (kind(*cell) == '.' and not near(cell, terrain, TERRAIN_CLEARANCE)
                and not near(cell, routes, ROUTE_CLEARANCE))

    rng = random.Random(SEED)
    for top in range(0, height, TILE):
        for left in range(0, width, TILE):
            tile = [(x, y) for y in range(top, min(top + TILE, height)) for x in range(left, min(left + TILE, width))]
            if any(cell in placed for cell in tile):
                continue
            rng.shuffle(tile)
            is_tree = rng.random() < TREE_SHARE
            is_pair = rng.random() < PAIR_SHARE
            for x, y in tile:
                footprint = [(x, y)] if is_tree or not is_pair else [(x, y), (x + 1, y)]
                if all(suitable(cell) and not near(cell, placed, OBSTACLE_SPACING) for cell in footprint):
                    for cx, cy in footprint:
                        grid[cy][cx] = 'T' if is_tree else 'B'
                    placed.update(footprint)
                    break
    if not connected(grid):
        sys.exit('balanced layout disconnects walkable terrain')
    return [''.join(row) for row in grid]


def main():
    layout = json.loads(LAYOUT.read_text())
    layout['rows'] = balance(layout['rows'])
    LAYOUT.write_text(json.dumps(layout, indent=2) + '\n')


if __name__ == '__main__':
    main()
