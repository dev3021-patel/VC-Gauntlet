import { describe, expect, it } from 'vitest'
import { isTraversable } from './playerPosition'
import { MOB_BODY_SIZE, laserLane, laserStop, laserStrike } from './laser'

describe('laser lane', () => {
  it('runs past four cells until terrain and names the blocking cell', () => {
    const origin = { x: 11, y: 4 }
    const lane = laserLane(origin, 'east')
    expect(lane.slice(0, 4)).toEqual([{ x: 12, y: 4 }, { x: 13, y: 4 }, { x: 14, y: 4 }, { x: 15, y: 4 }])
    expect(lane.length).toBeGreaterThan(4)
    expect(lane.every(isTraversable)).toBe(true)
    const stop = laserStop(origin, lane, 'east')
    if (stop) expect(isTraversable(stop)).toBe(false)
    else expect(lane.at(-1)!.x + 1).toBeGreaterThanOrEqual(80)
  })

  it('stops on the first body, with no terrain cap', () => {
    const origin = { x: 11, y: 4 }
    const { lane, target } = laserStrike(origin, 'east', [{ x: 14, y: 4, kind: 'player' }, { x: 20, y: 4, kind: 'player' }])
    expect(lane).toEqual([{ x: 12, y: 4 }, { x: 13, y: 4 }, { x: 14, y: 4 }])
    expect(target).toEqual({ x: 14, y: 4, kind: 'player' })
  })
  it('is empty against an adjacent wall, matching the backend fortress test', () => {
    const origin = { x: 66, y: 44 }
    expect(laserLane(origin, 'north')).toEqual([])
    expect(laserStop(origin, [], 'north')).toEqual({ x: 66, y: 43 })
  })
})

// Mirrors backend/tests/test_hitboxes.py so the aim guide and the server agree (Issue #110).
describe('avatar-sized enemy hitboxes', () => {
  const origin = { x: 10, y: 4 }
  const kept = (bodies: Parameters<typeof laserStrike>[2]) => {
    const { lane, target } = laserStrike(origin, 'east', bodies)
    return [target && { x: target.x, y: target.y }, lane.length]
  }
  const full = laserLane(origin, 'east').length

  it('strikes melee and ranged bodies off the center lane and misses two lanes away', () => {
    expect(MOB_BODY_SIZE).toBe(2.5)
    for (const kind of ['basic', 'ranged'] as const) {
      expect(kept([{ x: 15, y: 5, kind }])).toEqual([{ x: 15, y: 5 }, 4])
      expect(kept([{ x: 15, y: 3, kind }])[0]).toEqual({ x: 15, y: 3 })
      expect(kept([{ x: 15, y: 6, kind }])).toEqual([null, full])
    }
    expect(kept([{ x: 15, y: 4, kind: 'basic' }])).toEqual([{ x: 15, y: 4 }, 4])
    // Players keep their one-cell body.
    expect(kept([{ x: 15, y: 4, kind: 'player' }])).toEqual([{ x: 15, y: 4 }, 5])
    expect(kept([{ x: 15, y: 5, kind: 'player' }])).toEqual([null, full])
  })

  it('never strikes behind the shooter, and the nearest body edge wins', () => {
    expect(kept([{ x: 8, y: 4, kind: 'basic' }])).toEqual([null, full])
    expect(kept([{ x: 10, y: 5, kind: 'basic' }])).toEqual([{ x: 10, y: 5 }, 1])
    expect(kept([{ x: 15, y: 5, kind: 'basic' }, { x: 16, y: 4, kind: 'player' }])).toEqual([{ x: 15, y: 5 }, 4])
    expect(kept([{ x: 18, y: 5, kind: 'basic' }, { x: 15, y: 4, kind: 'player' }])).toEqual([{ x: 15, y: 4 }, 5])
  })

  it('lets terrain shield a body whose edge is past the wall', () => {
    // From (66, 45) north the fortress wall at row 43 leaves a single lane cell.
    const start = { x: 66, y: 45 }
    expect(laserLane(start, 'north')).toEqual([{ x: 66, y: 44 }])
    expect(laserStrike(start, 'north', [{ x: 67, y: 42, kind: 'basic' }]).target).toBeNull()
    expect(laserStrike(start, 'north', [{ x: 67, y: 44, kind: 'basic' }]).target).toEqual({ x: 67, y: 44, kind: 'basic' })
  })
})

