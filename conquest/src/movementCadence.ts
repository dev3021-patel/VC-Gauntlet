/**
 * Movement cadence for held-input repeats.
 *
 * Every player moves at the same standard speed: one orthogonal grid cell per
 * accepted move, with repeated move commands sent every `MOVE_REPEAT_MS`.
 * Holding Shift on a keyboard sprints at `SPRINT_REPEAT_MS` (2×); touch input
 * always uses the standard cadence.
 */
export const MOVE_REPEAT_MS = 80
export const SPRINT_REPEAT_MS = MOVE_REPEAT_MS / 2
/** Moves allowed in flight, so one confirmation round trip never stalls held input. */
export const MAX_MOVES_IN_FLIGHT = 2
