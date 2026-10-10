import type { PlayerPosition } from './playerPosition'
import { MOVEMENT_BLOCK_SIZE, movementBlockCenter } from './terrain'
import type { Point } from './viewport'

/**
 * Presentation-only interpolation state for one player marker.
 *
 * `target` is always the authoritative grid cell. `from`/`to` are world-space
 * block centers; the marker glides between them over `durationMs` starting at
 * `startMs`. Gameplay never reads this state: collisions, occupancy, facing,
 * and announcements stay on the authoritative position.
 */
export type MarkerMotion = Readonly<{
  target: PlayerPosition
  from: Point
  to: Point
  startMs: number
  durationMs: number
}>

export const MIN_STEP_DURATION_MS = 60

function sameCell(a: PlayerPosition, b: PlayerPosition) {
  return a.x === b.x && a.y === b.y
}

/** True when `next` is exactly one orthogonal movement block away from `previous`. */
export function isAdjacentStep(previous: PlayerPosition, next: PlayerPosition) {
  return Math.abs(next.x - previous.x) + Math.abs(next.y - previous.y) === 1
}

/** A motion that rests exactly on the authoritative cell with no animation. */
export function snapMotion(target: PlayerPosition): MarkerMotion {
  const center = movementBlockCenter(target.x, target.y)
  return { target, from: center, to: center, startMs: 0, durationMs: 0 }
}

/** Linear progress in [0, 1]; a zero-duration motion is always settled. */
export function motionProgress(motion: MarkerMotion, nowMs: number) {
  if (motion.durationMs <= 0) return 1
  return Math.min(1, Math.max(0, (nowMs - motion.startMs) / motion.durationMs))
}

export function isMotionSettled(motion: MarkerMotion, nowMs: number) {
  return motionProgress(motion, nowMs) >= 1
}

/** World-space point the marker should currently display. Settled motions return the exact cell center. */
export function displayedPoint(motion: MarkerMotion, nowMs: number): Point {
  const progress = motionProgress(motion, nowMs)
  if (progress >= 1) return motion.to
  return {
    x: motion.from.x + (motion.to.x - motion.from.x) * progress,
    y: motion.from.y + (motion.to.y - motion.from.y) * progress,
  }
}

/**
 * Advance a marker toward a newly accepted authoritative position.
 *
 * - No prior motion, reduced motion, or any change larger than one orthogonal
 *   cell snaps straight to the new cell (spawn, respawn, reconnect, teleport,
 *   corrections) so the marker never crosses intervening terrain.
 * - An adjacent step animates from the marker's *currently displayed* point,
 *   so a newer target arriving mid-animation retargets without replaying stale
 *   segments, queuing, or popping. `durationMs` is the time for one full cell;
 *   shorter or longer remaining distances scale it so the glide keeps a
 *   constant speed across reversals, turns, and back-to-back steps.
 * - An unchanged cell keeps the existing motion (e.g. facing-only updates).
 */
export function advanceMotion(
  previous: MarkerMotion | null,
  target: PlayerPosition,
  nowMs: number,
  durationMs: number,
  reducedMotion = false,
): MarkerMotion {
  if (!previous) return snapMotion(target)
  if (sameCell(previous.target, target)) return previous
  if (reducedMotion || durationMs <= 0 || !isAdjacentStep(previous.target, target)) return snapMotion(target)
  const from = displayedPoint(previous, nowMs)
  const to = movementBlockCenter(target.x, target.y)
  return {
    target,
    from,
    to,
    startMs: nowMs,
    durationMs: Math.round(durationMs * Math.hypot(to.x - from.x, to.y - from.y) / MOVEMENT_BLOCK_SIZE),
  }
}

/**
 * Duration for a remote player's next step. Remote speed boosts are not
 * observable directly, so match the interval between their last two accepted
 * steps, bounded to the normal cadence so a lone step never plays slowly.
 */
export function estimateStepDuration(previous: MarkerMotion | null, nowMs: number, cadenceMs: number) {
  if (!previous || previous.durationMs <= 0) return cadenceMs
  const interval = nowMs - previous.startMs
  return Math.min(cadenceMs, Math.max(MIN_STEP_DURATION_MS, interval))
}
