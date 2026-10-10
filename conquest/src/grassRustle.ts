import { grassColor } from './mapRenderer'
import type { MarkerMotion } from './markerMotion'
import type { MoveDirection } from './playerPosition'
import { MOVEMENT_BLOCK_SIZE, movementBlockCenter, movementBlockTerrain } from './terrain'

/**
 * Presentation-only grass response to a player stepping into a land cell.
 * Two tufts flank the avatar's lower half at a fixed on-screen size, clear of
 * the avatar and its name label at every zoom. The patch only shows while all
 * terrain under it is grass of the same shade, and blades use that color.
 *
 * Rustles are derived from marker-motion reconciliation and never own a
 * movement cadence: one is produced exactly when `advanceMotion` starts a new
 * animated adjacent step. Snaps (spawn, respawn, reconnect, teleport,
 * corrections, reduced motion) and unchanged cells (facing-only updates)
 * therefore never rustle. Only the recovery duration is timed here.
 */
export type GrassRustle = Readonly<{
  id: string
  x: number
  y: number
  direction: MoveDirection
  color: string
}>

export const GRASS_RUSTLE_MS = 350
export const MAX_GRASS_RUSTLES = 12
/** On-screen footprint of a patch in CSS pixels, relative to the entered cell center. Mirrors `.grass-rustle`. */
export const GRASS_PATCH = { width: 64, height: 12, offsetY: 4 } as const

/** The rustle for a reconciled marker motion, or null when the motion is not an animated step onto land. */
export function grassRustleFor(previous: MarkerMotion | null, next: MarkerMotion, id: string): GrassRustle | null {
  if (!previous || next === previous || next.durationMs <= 0) return null
  const { x, y } = next.target
  if (movementBlockTerrain(x, y) !== 'land') return null
  const dx = x - previous.target.x
  const dy = y - previous.target.y
  const direction: MoveDirection = dx > 0 ? 'east' : dx < 0 ? 'west' : dy > 0 ? 'south' : 'north'
  return { id, x, y, direction, color: grassColor(x, y) }
}

/** True when every movement block under the patch's on-screen footprint at `zoom` is land of the rustle's grass shade. */
export function grassPatchOnGrass(rustle: GrassRustle, zoom: number) {
  const center = movementBlockCenter(rustle.x, rustle.y)
  const halfWidth = GRASS_PATCH.width / 2 / zoom
  const top = center.y + (GRASS_PATCH.offsetY - GRASS_PATCH.height / 2) / zoom
  const bottom = center.y + (GRASS_PATCH.offsetY + GRASS_PATCH.height / 2) / zoom
  const block = (value: number) => Math.floor(value / MOVEMENT_BLOCK_SIZE)
  // The far edges are exclusive so a footprint ending exactly on a block boundary does not claim the next block.
  for (let y = block(top); y <= block(bottom - 1e-6); y += 1) {
    for (let x = block(center.x - halfWidth); x <= block(center.x + halfWidth - 1e-6); x += 1) {
      if (movementBlockTerrain(x, y) !== 'land' || grassColor(x, y) !== rustle.color) return false
    }
  }
  return true
}

/** Appends new rustles, keeping only the newest `MAX_GRASS_RUSTLES` so sustained movement stays bounded. */
export function addGrassRustles(current: readonly GrassRustle[], added: readonly GrassRustle[]): GrassRustle[] {
  return [...current, ...added].slice(-MAX_GRASS_RUSTLES)
}
