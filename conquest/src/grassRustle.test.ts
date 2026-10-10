import { describe, expect, it } from 'vitest'
import { addGrassRustles, grassPatchOnGrass, grassRustleFor, MAX_GRASS_RUSTLES, type GrassRustle } from './grassRustle'
import { grassColor } from './mapRenderer'
import { advanceMotion, snapMotion } from './markerMotion'
import { MOVE_REPEAT_MS } from './movementCadence'

const step = (from: { x: number; y: number }, to: { x: number; y: number }, reducedMotion = false) => {
  const previous = snapMotion(from)
  return { previous, next: advanceMotion(previous, to, 1_000, MOVE_REPEAT_MS, reducedMotion) }
}

describe('grassRustleFor', () => {
  it('rustles the entered land cell in its own grass color, leaning with the direction of travel', () => {
    const cases = [
      [{ x: 12, y: 4 }, 'east'],
      [{ x: 10, y: 4 }, 'west'],
      [{ x: 11, y: 5 }, 'south'],
      [{ x: 11, y: 3 }, 'north'],
    ] as const
    for (const [to, direction] of cases) {
      const { previous, next } = step({ x: 11, y: 4 }, to)
      expect(grassRustleFor(previous, next, 'r')).toEqual({ id: 'r', x: to.x, y: to.y, direction, color: grassColor(to.x, to.y) })
    }
  })

  it('matches the darker grass band of the terrain', () => {
    const { previous, next } = step({ x: 12, y: 30 }, { x: 11, y: 30 })
    expect(grassRustleFor(previous, next, 'r')?.color).toBe('#7c8852')
  })

  it('ignores steps onto bridges and courtyards', () => {
    const bridge = step({ x: 57, y: 32 }, { x: 58, y: 32 })
    expect(grassRustleFor(bridge.previous, bridge.next, 'r')).toBeNull()
    const courtyard = step({ x: 7, y: 14 }, { x: 8, y: 14 })
    expect(grassRustleFor(courtyard.previous, courtyard.next, 'r')).toBeNull()
  })

  it('follows marker-motion snaps: first placement, jumps, unchanged cells, and reduced motion never rustle', () => {
    const placed = advanceMotion(null, { x: 11, y: 4 }, 1_000, MOVE_REPEAT_MS)
    expect(grassRustleFor(null, placed, 'r')).toBeNull()
    const jump = step({ x: 11, y: 4 }, { x: 30, y: 20 })
    expect(grassRustleFor(jump.previous, jump.next, 'r')).toBeNull()
    const diagonal = step({ x: 11, y: 4 }, { x: 12, y: 5 })
    expect(grassRustleFor(diagonal.previous, diagonal.next, 'r')).toBeNull()
    const unchanged = step({ x: 11, y: 4 }, { x: 11, y: 4 })
    expect(unchanged.next).toBe(unchanged.previous)
    expect(grassRustleFor(unchanged.previous, unchanged.next, 'r')).toBeNull()
    const reduced = step({ x: 11, y: 4 }, { x: 12, y: 4 }, true)
    expect(grassRustleFor(reduced.previous, reduced.next, 'r')).toBeNull()
  })
})

describe('grassPatchOnGrass', () => {
  const rustleAt = (x: number, y: number): GrassRustle => ({ id: 'r', x, y, direction: 'east', color: grassColor(x, y) })

  it('shows a patch whose whole footprint is grass of the same shade at close and wide zoom', () => {
    expect(grassPatchOnGrass(rustleAt(11, 4), 4)).toBe(true)
    expect(grassPatchOnGrass(rustleAt(11, 4), 1)).toBe(true)
  })

  it('hides a patch that would overlap water or a different grass shade', () => {
    expect(grassPatchOnGrass(rustleAt(78, 2), 4)).toBe(false)
    expect(grassPatchOnGrass(rustleAt(11, 26), 1)).toBe(false)
    expect(grassPatchOnGrass(rustleAt(11, 24), 4)).toBe(true)
  })
})

describe('addGrassRustles', () => {
  it('keeps only the newest rustles during sustained movement', () => {
    const rustle = (index: number): GrassRustle => ({ id: `r${index}`, x: index, y: 0, direction: 'east', color: '#63945c' })
    let active: GrassRustle[] = []
    for (let index = 0; index < MAX_GRASS_RUSTLES + 5; index += 1) active = addGrassRustles(active, [rustle(index)])
    expect(active).toHaveLength(MAX_GRASS_RUSTLES)
    expect(active[0].id).toBe('r5')
    expect(active.at(-1)!.id).toBe(`r${MAX_GRASS_RUSTLES + 4}`)
  })
})
