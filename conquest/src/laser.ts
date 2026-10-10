import { isTraversable, type MoveDirection, type PlayerPosition } from './playerPosition'
import { MOVEMENT_WORLD } from './terrain'

/** The laser crosses the whole map; mirrors `LASER_RANGE` in `backend/app/player_positions.py`. */
export const LASER_RANGE = Math.max(MOVEMENT_WORLD.width, MOVEMENT_WORLD.height)
/** How long a fired laser stays on screen, animated or (reduced motion) static. */
export const LASER_FLASH_MS = 520
/** One shot per second; the server enforces the same cadence (`SHOT_COOLDOWN_SECONDS`). */
export const LASER_COOLDOWN_MS = 1000

export const LASER_OFFSETS: Record<MoveDirection, PlayerPosition> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
  east: { x: 1, y: 0 },
}

export const cellKey = (cell: PlayerPosition) => `${cell.x},${cell.y}`

/** Mirrors `app.hitboxes`: enemy bodies are this many cells across at every zoom, as drawn. */
export const MOB_BODY_SIZE = 2.5
const PLAYER_BODY_SIZE = 1
/** The drawn beam is a fifth of a cell thick. */
const LASER_HALF_WIDTH = 0.1

/** A unit a laser can strike: players are round single cells, melee mobs square and ranged mobs round. */
export type LaserBody = PlayerPosition & { kind: 'player' | 'basic' | 'ranged' }

/** First contact fraction of a segment with a closed axis-aligned box (`segment_box`). */
function segmentBox(start: PlayerPosition, end: PlayerPosition, center: PlayerPosition, radius: number) {
  let enter = 0
  let leave = 1
  for (const axis of ['x', 'y'] as const) {
    const delta = end[axis] - start[axis]
    if (Math.abs(delta) < 1e-12) {
      if (start[axis] < center[axis] - radius || start[axis] > center[axis] + radius) return null
      continue
    }
    const [first, last] = [(center[axis] - radius - start[axis]) / delta, (center[axis] + radius - start[axis]) / delta].sort((a, b) => a - b)
    enter = Math.max(enter, first)
    leave = Math.min(leave, last)
    if (enter > leave) return null
  }
  return enter
}

/** First contact fraction of a segment with a closed circle (`segment_circle`). */
function segmentCircle(start: PlayerPosition, end: PlayerPosition, center: PlayerPosition, radius: number) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const ox = start.x - center.x
  const oy = start.y - center.y
  const c = ox * ox + oy * oy - radius ** 2
  if (c <= 0) return 0
  if (length < 1e-12) return null
  const projection = (ox * dx + oy * dy) / length
  const discriminant = projection ** 2 - c
  if (discriminant < 0) return null
  const contact = (-projection - Math.sqrt(discriminant)) / length
  return contact >= 0 && contact <= 1 ? contact : null
}

function bodyContact(start: PlayerPosition, end: PlayerPosition, body: LaserBody) {
  const radius = (body.kind === 'player' ? PLAYER_BODY_SIZE : MOB_BODY_SIZE) / 2 + LASER_HALF_WIDTH
  return (body.kind === 'basic' ? segmentBox : segmentCircle)(start, end, body, radius)
}

/** The traversable cells a laser crosses before terrain or the map edge, nearest first. */
export function laserLane(origin: PlayerPosition, direction: MoveDirection) {
  const offset = LASER_OFFSETS[direction]
  const lane: PlayerPosition[] = []
  for (let distance = 1; distance <= LASER_RANGE; distance += 1) {
    const cell = { x: origin.x + offset.x * distance, y: origin.y + offset.y * distance }
    if (!isTraversable(cell)) break
    lane.push(cell)
  }
  return lane
}

/**
 * The laser the server will resolve (`laser_strike`): the first body whose
 * footprint touches the beam, even off the lane, and the lane cut to the cell
 * holding that contact. Without a strike the full terrain lane is returned.
 */
export function laserStrike(origin: PlayerPosition, direction: MoveDirection, bodies: readonly LaserBody[] = []) {
  const lane = laserLane(origin, direction)
  if (lane.length === 0) return { lane, target: null }
  const offset = LASER_OFFSETS[direction]
  const start = { x: origin.x + offset.x * 0.5, y: origin.y + offset.y * 0.5 }
  const end = { x: origin.x + offset.x * (lane.length + 0.5), y: origin.y + offset.y * (lane.length + 0.5) }
  let nearest = Infinity
  let target: LaserBody | null = null
  // Cells break ties, as on the server.
  const ordered = [...bodies].sort((a, b) => a.x - b.x || a.y - b.y)
  for (const body of ordered) {
    const contact = bodyContact(start, end, body)
    if (contact !== null && contact < nearest) {
      nearest = contact
      target = body
    }
  }
  if (!target) return { lane, target }
  // Undo the beam padding so the kept cell is the one holding the body's own edge.
  const distance = 0.5 + nearest * lane.length + LASER_HALF_WIDTH
  return { lane: lane.slice(0, Math.min(lane.length, Math.max(1, Math.floor(distance + 0.5 + 1e-9)))), target }
}

/** The on-map terrain cell that ended a lane, or null when a unit or the map edge ended it. */
export function laserStop(origin: PlayerPosition, lane: readonly PlayerPosition[], direction: MoveDirection): PlayerPosition | null {
  const offset = LASER_OFFSETS[direction]
  const last = lane.at(-1) ?? origin
  const next = { x: last.x + offset.x, y: last.y + offset.y }
  const onMap = next.x >= 0 && next.x < MOVEMENT_WORLD.width && next.y >= 0 && next.y < MOVEMENT_WORLD.height
  return onMap && !isTraversable(next) ? next : null
}
