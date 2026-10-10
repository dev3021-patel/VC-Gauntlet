import { describe, expect, it } from 'vitest'
import {
  advanceMotion,
  displayedPoint,
  estimateStepDuration,
  isAdjacentStep,
  isMotionSettled,
  MIN_STEP_DURATION_MS,
  snapMotion,
} from './markerMotion'
import { movementBlockCenter } from './terrain'

const center = (x: number, y: number) => movementBlockCenter(x, y)

describe('isAdjacentStep', () => {
  it('accepts exactly one orthogonal cell and rejects diagonals, jumps, and no movement', () => {
    expect(isAdjacentStep({ x: 4, y: 4 }, { x: 5, y: 4 })).toBe(true)
    expect(isAdjacentStep({ x: 4, y: 4 }, { x: 4, y: 3 })).toBe(true)
    expect(isAdjacentStep({ x: 4, y: 4 }, { x: 5, y: 5 })).toBe(false)
    expect(isAdjacentStep({ x: 4, y: 4 }, { x: 6, y: 4 })).toBe(false)
    expect(isAdjacentStep({ x: 4, y: 4 }, { x: 4, y: 4 })).toBe(false)
  })
})

describe('advanceMotion', () => {
  it('snaps the first placement to the authoritative cell center', () => {
    const motion = advanceMotion(null, { x: 11, y: 4 }, 1_000, 200)
    expect(motion).toEqual(snapMotion({ x: 11, y: 4 }))
    expect(isMotionSettled(motion, 1_000)).toBe(true)
    expect(displayedPoint(motion, 1_000)).toEqual(center(11, 4))
  })

  it('interpolates an adjacent step linearly and finishes exactly on the new cell center', () => {
    const rest = snapMotion({ x: 11, y: 4 })
    const motion = advanceMotion(rest, { x: 12, y: 4 }, 1_000, 200)
    expect(motion.target).toEqual({ x: 12, y: 4 })
    expect(displayedPoint(motion, 1_000)).toEqual(center(11, 4))
    expect(displayedPoint(motion, 1_100)).toEqual({ x: (center(11, 4).x + center(12, 4).x) / 2, y: center(11, 4).y })
    expect(isMotionSettled(motion, 1_199)).toBe(false)
    expect(displayedPoint(motion, 1_200)).toEqual(center(12, 4))
    expect(displayedPoint(motion, 5_000)).toEqual(center(12, 4))
    expect(isMotionSettled(motion, 1_200)).toBe(true)
  })

  it('retargets mid-animation from the displayed point without replaying the stale segment', () => {
    const first = advanceMotion(snapMotion({ x: 11, y: 4 }), { x: 12, y: 4 }, 1_000, 200)
    const midway = displayedPoint(first, 1_100)
    const second = advanceMotion(first, { x: 12, y: 5 }, 1_100, 200)
    expect(second.from).toEqual(midway)
    expect(second.to).toEqual(center(12, 5))
    expect(second.startMs).toBe(1_100)
    // The displayed path heads straight for the newest target at the same speed; the old segment is not completed first.
    expect(second.durationMs).toBe(Math.round(200 * Math.hypot(0.5, 1)))
    expect(displayedPoint(second, 1_100)).toEqual(midway)
    expect(displayedPoint(second, 1_100 + second.durationMs)).toEqual(center(12, 5))
  })

  it('keeps a constant speed when reversing mid-step', () => {
    const first = advanceMotion(snapMotion({ x: 11, y: 4 }), { x: 12, y: 4 }, 1_000, 80)
    const back = advanceMotion(first, { x: 11, y: 4 }, 1_040, 80)
    expect(back.durationMs).toBe(40)
    expect(displayedPoint(back, 1_080)).toEqual(center(11, 4))
  })

  it('carries consecutive steps across cell boundaries without pausing', () => {
    const first = advanceMotion(snapMotion({ x: 11, y: 4 }), { x: 12, y: 4 }, 1_000, 80)
    const second = advanceMotion(first, { x: 13, y: 4 }, 1_080, 80)
    const third = advanceMotion(second, { x: 14, y: 4 }, 1_160, 80)
    const block = center(12, 4).x - center(11, 4).x
    // Equal elapsed time covers equal distance across every boundary: a steady glide.
    expect(displayedPoint(first, 1_040).x).toBe(center(11, 4).x + block / 2)
    expect(displayedPoint(second, 1_120).x).toBe(center(12, 4).x + block / 2)
    expect(displayedPoint(third, 1_200).x).toBe(center(13, 4).x + block / 2)
    expect(isMotionSettled(third, 1_239)).toBe(false)
    expect(displayedPoint(third, 1_240)).toEqual(center(14, 4))
  })

  it('keeps the existing motion when the authoritative cell is unchanged', () => {
    const moving = advanceMotion(snapMotion({ x: 11, y: 4 }), { x: 12, y: 4 }, 1_000, 200)
    expect(advanceMotion(moving, { x: 12, y: 4 }, 1_050, 200)).toBe(moving)
  })

  it.each([
    ['a two-cell correction', { x: 13, y: 4 }],
    ['a diagonal change', { x: 12, y: 5 }],
    ['a teleport-like relocation', { x: 40, y: 39 }],
  ])('snaps %s instead of crossing intervening terrain', (_label, target) => {
    const motion = advanceMotion(snapMotion({ x: 11, y: 4 }), target, 1_000, 200)
    expect(motion).toEqual(snapMotion(target))
    expect(displayedPoint(motion, 1_050)).toEqual(center(target.x, target.y))
  })

  it('snaps adjacent steps when reduced motion is requested', () => {
    const motion = advanceMotion(snapMotion({ x: 11, y: 4 }), { x: 12, y: 4 }, 1_000, 200, true)
    expect(motion).toEqual(snapMotion({ x: 12, y: 4 }))
  })

  it('honours the speed-boost cadence as a shorter step duration', () => {
    const motion = advanceMotion(snapMotion({ x: 11, y: 4 }), { x: 12, y: 4 }, 1_000, 100)
    expect(isMotionSettled(motion, 1_099)).toBe(false)
    expect(displayedPoint(motion, 1_100)).toEqual(center(12, 4))
  })
})

describe('estimateStepDuration', () => {
  it('uses the normal cadence for a first or resting step', () => {
    expect(estimateStepDuration(null, 1_000, 200)).toBe(200)
    expect(estimateStepDuration(snapMotion({ x: 1, y: 1 }), 1_000, 200)).toBe(200)
  })

  it('matches faster successive remote steps to their observed interval, bounded by the cadence', () => {
    const step = advanceMotion(snapMotion({ x: 1, y: 1 }), { x: 2, y: 1 }, 1_000, 200)
    expect(estimateStepDuration(step, 1_100, 200)).toBe(100)
    expect(estimateStepDuration(step, 1_900, 200)).toBe(200)
    expect(estimateStepDuration(step, 1_005, 200)).toBe(MIN_STEP_DURATION_MS)
  })
})
