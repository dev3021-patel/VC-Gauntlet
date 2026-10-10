"""Map topology and continuity invariants, independent of the live database."""
import asyncio
import uuid
from collections import deque

import pytest

from app.player_positions import (
    MAP_LAYOUT, MOVEMENT_WORLD_SIZE, DIRECTIONS, block_terrain, block_is_traversable,
    first_spawn_block, arrow_path, relocate_invalid_positions, safe_spawn_block,
)
from app.world_transport import TransportError


def walkable():
    return {(x, y) for y in range(MOVEMENT_WORLD_SIZE) for x in range(MOVEMENT_WORLD_SIZE)
            if block_is_traversable(x, y)}


def test_quadrupled_map_is_exactly_80_square_and_one_connected_region():
    assert MOVEMENT_WORLD_SIZE == 80
    assert all(len(row) == 80 for row in MAP_LAYOUT['rows'])
    cells = walkable()
    seen = {next(iter(cells))}
    queue = deque(seen)
    while queue:
        x, y = queue.popleft()
        for dx, dy in DIRECTIONS.values():
            candidate = (x + dx, y + dy)
            if candidate in cells and candidate not in seen:
                seen.add(candidate)
                queue.append(candidate)
    assert seen == cells


def test_original_map_landmarks_are_shifted_into_lower_right_quadrant():
    for x, y, kind in [
        (69, 43, 'wall'), (70, 44, 'courtyard'), (44, 45, 'tree'),
        (48, 46, 'barricade'), (58, 49, 'bridge'), (59, 60, 'bridge'),
        (60, 72, 'bridge'),
    ]:
        assert block_terrain(x, y) == kind
    assert block_terrain(50, 40) == 'land'
    assert block_terrain(40, 55) == 'land'


def test_extended_river_reaches_old_channel_and_exits_outer_right_edge():
    river = {(x, y) for y in range(80) for x in range(80)
             if block_terrain(x, y) in {'water', 'bridge'}}
    seen = {(59, 41)}
    queue = deque(seen)
    while queue:
        x, y = queue.popleft()
        for dx, dy in DIRECTIONS.values():
            candidate = (x + dx, y + dy)
            if candidate in river and candidate not in seen:
                seen.add(candidate)
                queue.append(candidate)
    assert (79, 12) in seen
    assert (59, 39) in seen
    assert all(block_terrain(x, 32) == 'bridge' for x in range(58, 61))
    assert block_is_traversable(58, 32) and block_is_traversable(60, 32)


ENCLOSURES = ((8, 7, 27, 23), (8, 50, 27, 68), (65, 43, 76, 54))
MIN_ENTRANCE_WIDTH = 4
OPPOSITE = {'north': 'south', 'south': 'north', 'east': 'west', 'west': 'east'}


def courtyard_entrances():
    """Each run of courtyard cells that opens onto outside walkable ground, with its outward direction."""
    openings = {}
    for y in range(MOVEMENT_WORLD_SIZE):
        for x in range(MOVEMENT_WORLD_SIZE):
            if block_terrain(x, y) != 'courtyard':
                continue
            for direction, (dx, dy) in DIRECTIONS.items():
                if block_is_traversable(x + dx, y + dy) and block_terrain(x + dx, y + dy) != 'courtyard':
                    openings[(x, y)] = direction
    runs = []
    for cell, direction in sorted(openings.items()):
        dx, dy = DIRECTIONS[direction]
        previous = (cell[0] - abs(dy), cell[1] - abs(dx))
        run = next((run for run in runs if run[0] == direction and run[1][-1] == previous), None)
        if run:
            run[1].append(cell)
        else:
            runs.append((direction, [cell]))
    return runs


@pytest.mark.parametrize('bounds', ENCLOSURES)
def test_enclosures_have_blocking_walls_and_walkable_courtyards(bounds):
    x1, y1, x2, y2 = bounds
    assert block_terrain(x1 + 1, y1 + 1) == 'courtyard'
    assert block_is_traversable(x1 + 1, y1 + 1)
    for corner in ((x1, y1), (x2, y1), (x1, y2), (x2, y2)):
        assert block_terrain(*corner) == 'wall'
        assert not block_is_traversable(*corner)


def test_existing_entrances_keep_their_place_and_are_four_wide():
    # Issue #118: each opening widened to four squares around its original gap.
    assert sorted((direction, cells[0], len(cells)) for direction, cells in courtyard_entrances()) == sorted([
        ('west', (8, 13), 4), ('south', (16, 23), 4),
        ('north', (16, 50), 4), ('east', (27, 58), 4),
        ('west', (65, 47), 4), ('south', (69, 54), 4),
    ])


def test_every_entrance_is_wide_with_clear_approaches_on_both_sides():
    # Applies to every walled courtyard, including any added later, so new structures meet the same standard.
    for direction, cells in courtyard_entrances():
        assert len(cells) >= MIN_ENTRANCE_WIDTH, (direction, cells)
        dx, dy = DIRECTIONS[direction]
        for x, y in cells:
            # A straight lane runs two squares out into the map and one square into the courtyard.
            assert block_terrain(x - dx, y - dy) == 'courtyard'
            assert all(block_is_traversable(x + dx * step, y + dy * step) for step in (-1, 1, 2)), (x, y)
            assert arrow_path(x - dx, y - dy, direction)[:3] == [(x, y), (x + dx, y + dy), (x + 2 * dx, y + 2 * dy)]
            assert arrow_path(x + 2 * dx, y + 2 * dy, OPPOSITE[direction])[:3] == [
                (x + dx, y + dy), (x, y), (x - dx, y - dy)]


def test_world_boundaries_and_every_quadrant_support_gameplay_rules():
    assert all(block_terrain(x, 0) == 'water' and block_terrain(x, 79) == 'water' for x in range(80))
    assert all(block_terrain(0, y) == 'water' and block_terrain(79, y) == 'water' for y in range(80))
    for cell in ((4, 4), (44, 4), (4, 44), (44, 44)):
        assert safe_spawn_block(cell, set())


BRIDGE_ROWS = {32: range(31, 35), 49: range(48, 52), 60: range(59, 63), 71: range(70, 74)}


def bridge_spans():
    """Each bridge's rows, grouped by contiguous bridge tiles on the river."""
    rows = sorted({y for y in range(80) for x in range(80) if block_terrain(x, y) == 'bridge'})
    spans, current = [], [rows[0]]
    for y in rows[1:]:
        if y == current[-1] + 1:
            current.append(y)
        else:
            spans.append(current)
            current = [y]
    return [*spans, current]


def test_every_bridge_is_four_tiles_wide_with_full_width_approaches():
    # Issue #110: widened from one or two rows to four, centred on the original crossings.
    assert [range(span[0], span[-1] + 1) for span in bridge_spans()] == list(BRIDGE_ROWS.values())
    for span in bridge_spans():
        assert len(span) >= 4
        for y in span:
            # The whole river, and nothing else, is planked; both banks are open land.
            assert [block_terrain(x, y) for x in range(57, 62)] == ['land', 'bridge', 'bridge', 'bridge', 'land']
            assert arrow_path(57, y, 'east')[:4] == [(58, y), (59, y), (60, y), (61, y)]
            assert arrow_path(61, y, 'west')[:4] == [(60, y), (59, y), (58, y), (57, y)]
        # Water bounds each crossing on both sides.
        assert block_terrain(59, span[0] - 1) == 'water' and block_terrain(59, span[-1] + 1) == 'water'


def test_every_bridge_lane_can_be_walked_across_in_both_directions():
    cells = walkable()
    for span in bridge_spans():
        for y in span:
            # Each lane is a straight, unobstructed walk from bank to bank, and every widened
            # lane joins its neighbours, so no lane is disconnected from the others.
            assert all((x, y) in cells for x in range(56, 63))
            assert y == span[-1] or all((x, y + 1) in cells for x in range(58, 61))


def test_bridges_cover_and_fortress_follow_arrow_and_movement_rules():
    assert not block_is_traversable(58, 47)
    for x, y, kind in [(44, 45, 'tree'), (48, 56, 'barricade'), (69, 43, 'wall')]:
        assert block_terrain(x, y) == kind
        assert not block_is_traversable(x, y)
        assert arrow_path(x, y + 1, 'north') == []
    assert arrow_path(70, 56, 'north')[:4] == [(70, 55), (70, 54), (70, 53), (70, 52)]
    assert arrow_path(63, 48, 'east')[:4] == [(64, 48), (65, 48), (66, 48), (67, 48)]
    for x, y in walkable():
        for direction, (dx, dy) in DIRECTIONS.items():
            path = arrow_path(x, y, direction)
            assert all(block_is_traversable(*cell) for cell in path)
            # The laser runs until terrain or the map edge, never stopping short on open ground.
            end = path[-1] if path else (x, y)
            assert not block_is_traversable(end[0] + dx, end[1] + dy)
            if not block_is_traversable(x + dx, y + dy):
                assert path == []


def test_spawn_needs_a_free_exit_and_exhaustion_is_recoverable():
    cells = walkable()
    assert first_spawn_block((11, 4), cells - {(11, 4)}) is None
    chosen = first_spawn_block((11, 4), {(10, 4), (12, 4), (11, 3), (11, 5)})
    assert chosen != (11, 4)
    assert first_spawn_block((11, 4), set()) == (11, 4)
    assert first_spawn_block(None, cells) is None


class Positions:
    def __init__(self, cells):
        self.rows = [dict(player_id=uuid.uuid4(), name=f'Player {i}', avatar='moss', x=x, y=y, revision=7)
                     for i, (x, y) in enumerate(cells)]

    async def fetch(self, query, world_id):
        return [dict(row) for row in self.rows]

    async def fetchrow(self, query, world_id, player_id, x, y):
        assert not any((row['x'], row['y']) == (x, y) for row in self.rows)
        row = next(row for row in self.rows if row['player_id'] == player_id)
        row.update(x=x, y=y, revision=row['revision'] + 1)
        return row


def test_relocation_preserves_valid_positions_and_identity_without_overlap():
    connection = Positions([(51, 44), (44, 45), (58, 47), (69, 43)])
    identities = [row['player_id'] for row in connection.rows]
    result = asyncio.run(relocate_invalid_positions(connection, 'test'))
    assert len(result) == 3
    assert connection.rows[0]['x'] == 51 and connection.rows[0]['y'] == 44
    assert connection.rows[0]['revision'] == 7
    assert [row['player_id'] for row in connection.rows] == identities
    assert all(block_is_traversable(row['x'], row['y']) for row in connection.rows)
    assert len({(row['x'], row['y']) for row in connection.rows}) == 4
    assert asyncio.run(relocate_invalid_positions(connection, 'test')) == []


def test_relocation_reports_no_capacity_without_losing_identity():
    connection = Positions([*sorted(walkable()), (44, 45)])
    before = [dict(row) for row in connection.rows]
    with pytest.raises(TransportError) as error:
        asyncio.run(relocate_invalid_positions(connection, 'test'))
    assert error.value.code == 'no_spawn_available'
    assert connection.rows == before


def test_trees_and_barricades_are_balanced_across_quadrants_and_keep_routes_open():
    # Issue #119: every quadrant sits between the former sparse (4) and dense (39) obstacle counts.
    for left, top in ((0, 0), (40, 0), (0, 40), (40, 40)):
        kinds = [block_terrain(x, y) for y in range(top, top + 40) for x in range(left, left + 40)]
        assert 4 < kinds.count('tree') + kinds.count('barricade') < 39
        assert kinds.count('tree') and kinds.count('barricade')
    obstacles = {(x, y) for y in range(80) for x in range(80) if block_terrain(x, y) in {'tree', 'barricade'}}
    # Bridges and courtyard openings keep obstacle-free approaches.
    openings = {(x, y) for y in range(80) for x in range(80) if block_terrain(x, y) == 'bridge' or (
        block_terrain(x, y) == 'courtyard'
        and any(block_terrain(x + dx, y + dy) == 'land' for dx, dy in DIRECTIONS.values()))}
    for x, y in obstacles:
        assert all(abs(x - ox) > 4 or abs(y - oy) > 4 for ox, oy in openings)
