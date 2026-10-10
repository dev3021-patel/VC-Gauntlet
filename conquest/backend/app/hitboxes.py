"""Unit bodies for laser and rocket collisions, in world cells (Issue #110).

Every enemy body is ``MOB_BODY_SIZE`` cells across, centered on its cell, and
the client draws it at exactly that size at every zoom (``MOB_BODY_SIZE`` in
``src/laser.ts``), so what a player sees is what a shot can hit. Melee mobs
are square and ranged mobs round, matching their art; health bars, labels,
glow, and animations are not part of a body. Players keep their one-cell
round body. A shot is a swept segment padded by its own half-width; the
earliest contact along it wins, and terrain is checked by the caller.
"""

from __future__ import annotations

import math

MOB_BODY_SIZE = 2.5
PLAYER_BODY_SIZE = 1.0
# The drawn laser beam is a fifth of a cell thick.
LASER_HALF_WIDTH = 0.1
SQUARE_KINDS = frozenset({"basic"})


def body_kind(body) -> str:
    """``basic`` / ``ranged`` for mob rows, ``player`` for anything else."""
    kind = body.get("kind") if hasattr(body, "get") else None
    return kind if isinstance(kind, str) else "player"


def segment_box(origin, end, center, radius):
    """First contact fraction of a segment with a closed axis-aligned box."""
    enter, leave = 0.0, 1.0
    for start, finish, mid in zip(origin, end, center):
        delta = finish - start
        if abs(delta) < 1e-12:
            if not mid - radius <= start <= mid + radius:
                return None
            continue
        first, last = sorted(((mid - radius - start) / delta, (mid + radius - start) / delta))
        enter, leave = max(enter, first), min(leave, last)
        if enter > leave:
            return None
    return enter


def segment_circle(origin, end, center, radius):
    """First contact fraction of a segment with a closed circle."""
    dx, dy = end[0] - origin[0], end[1] - origin[1]
    length = math.hypot(dx, dy)
    ox, oy = origin[0] - center[0], origin[1] - center[1]
    c = ox * ox + oy * oy - radius ** 2
    if c <= 0:
        return 0.0
    if length < 1e-12:
        return None
    projection = (ox * dx + oy * dy) / length
    discriminant = projection ** 2 - c
    if discriminant < 0:
        return None
    contact = (-projection - math.sqrt(discriminant)) / length
    return contact if 0 <= contact <= 1 else None


def body_contact(origin, end, center, kind: str, pad: float):
    """First contact fraction of a shot ``pad`` cells thick with one unit's body."""
    size = PLAYER_BODY_SIZE if kind == "player" else MOB_BODY_SIZE
    shape = segment_box if kind in SQUARE_KINDS else segment_circle
    return shape(origin, end, center, size / 2 + pad)


def laser_strike(origin, offset, lane_length: int, bodies):
    """The body a laser lane strikes first and the lane cell count it keeps.

    The beam runs from the shooter's leading edge to the far edge of its last
    lane cell. ``bodies`` maps cells to unit rows (see ``body_kind``). Returns
    ``(cell, kept)``: the struck body's cell (or ``None``) and the number of
    lane cells the beam keeps, ending on the cell holding the contact point.
    """
    if lane_length <= 0:
        return None, 0
    start = (origin[0] + offset[0] * 0.5, origin[1] + offset[1] * 0.5)
    end = (origin[0] + offset[0] * (lane_length + 0.5), origin[1] + offset[1] * (lane_length + 0.5))
    nearest, struck = math.inf, None
    # Cells break ties so the result never depends on dictionary order.
    for cell in sorted(bodies):
        contact = body_contact(start, end, cell, body_kind(bodies[cell]), LASER_HALF_WIDTH)
        if contact is not None and contact < nearest:
            nearest, struck = contact, cell
    if struck is None:
        return None, lane_length
    # Undo the beam padding so the kept cell is the one holding the body's own edge.
    distance = 0.5 + nearest * lane_length + LASER_HALF_WIDTH
    return struck, min(lane_length, max(1, math.floor(distance + 0.5 + 1e-9)))
