import { describe, expect, it } from 'vitest'
import terrainContract from '../terrain-contract.json'
import { movementBlockCenter, movementBlockTerrain, MOVEMENT_WORLD, terrainAt, WORLD } from './terrain'
import {
  directionForKey,
  isTraversable,
  loadPlayerPosition,
  movePlayer,
  randomSpawn,
  savePlayerPosition,
  PLAYER_POSITION_STORAGE_PREFIX,
  PLAYER_POSITION_STORAGE_VERSION,
  type MoveDirection,
  type PlayerPosition,
} from './playerPosition'
import type { StorageLike } from './session/storage'

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

function landWithNeighbor(direction: MoveDirection, traversable: boolean): PlayerPosition {
  const delta = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[direction]
  for (let y = 0; y < MOVEMENT_WORLD.height; y += 1) {
    for (let x = 0; x < MOVEMENT_WORLD.width; x += 1) {
      const neighbor = { x: x + delta[0], y: y + delta[1] }
      if (isTraversable({ x, y }) && isTraversable(neighbor) === traversable) return { x, y }
    }
  }
  throw new Error('Expected terrain boundary was not found')
}

describe('player position storage and spawning', () => {
  it('matches the server terrain contract across the complete grid', () => {
    const codes = { water: 0, wall: 1, land: 2, tree: 3, barricade: 4, bridge: 5, courtyard: 6 } as const
    let checksum = 2_166_136_261
    for (let y = 0; y < WORLD.height; y += 1) {
      for (let x = 0; x < WORLD.width; x += 1) {
        checksum ^= codes[terrainAt(x, y)]
        checksum = Math.imul(checksum, 16_777_619) >>> 0
      }
    }
    expect(checksum.toString(16).padStart(8, '0')).toBe(terrainContract.fnv1a32)
  })

  it('spawns on traversable land for random values across the range', () => {
    for (const value of [0, 0.1, 0.5, 0.999999]) expect(isTraversable(randomSpawn(() => value))).toBe(true)
  })

  it('centers markers in the corresponding 8x8 terrain region', () => {
    expect(movementBlockCenter(0, 0)).toEqual({ x: 4, y: 4 })
    expect(movementBlockCenter(11, 4)).toEqual({ x: 92, y: 36 })
    expect(movementBlockCenter(31, 31)).toEqual({ x: 252, y: 252 })
  })

  it('stores independent positions by player ID and restores them', () => {
    const storage = memoryStorage()
    const first = landWithNeighbor('east', true)
    const second = movePlayer(first, 'east')
    expect(savePlayerPosition('player/one', first, storage)).toBe(true)
    expect(savePlayerPosition('player/two', second, storage)).toBe(true)
    expect(loadPlayerPosition('player/one', storage)).toEqual(first)
    expect(loadPlayerPosition('player/two', storage)).toEqual(second)
  })

  it('rejects malformed, fractional, blocked, and out-of-bounds saved positions', () => {
    const cases = [
      'not-json',
      JSON.stringify({ version: 1, x: 11, y: 4 }),
      JSON.stringify({ version: PLAYER_POSITION_STORAGE_VERSION, x: 1.5, y: 2 }),
      JSON.stringify({ version: PLAYER_POSITION_STORAGE_VERSION, x: 0, y: 0 }),
      JSON.stringify({ version: PLAYER_POSITION_STORAGE_VERSION, x: MOVEMENT_WORLD.width, y: 10 }),
    ]
    for (const raw of cases) {
      const storage = memoryStorage({ [`${PLAYER_POSITION_STORAGE_PREFIX}p1`]: raw })
      expect(loadPlayerPosition('p1', storage)).toBeNull()
    }
  })

  it('keeps working when storage is unavailable or throws', () => {
    const throwing: StorageLike = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => {} }
    expect(loadPlayerPosition('p1', null)).toBeNull()
    expect(loadPlayerPosition('p1', throwing)).toBeNull()
    expect(savePlayerPosition('p1', randomSpawn(() => 0), throwing)).toBe(false)
    const dropping: StorageLike = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    expect(savePlayerPosition('p1', randomSpawn(() => 0), dropping)).toBe(false)
  })
})

describe('grid movement', () => {
  it('maps WASD and arrows to all four orthogonal directions', () => {
    expect(['w', 'ArrowUp', 's', 'ArrowDown', 'a', 'ArrowLeft', 'd', 'ArrowRight'].map(directionForKey)).toEqual([
      'north', 'north', 'south', 'south', 'west', 'west', 'east', 'east',
    ])
    expect(directionForKey('x')).toBeNull()
  })

  it('moves one 8x8 terrain block in each direction when land is available', () => {
    for (const direction of ['north', 'south', 'west', 'east'] as const) {
      const start = landWithNeighbor(direction, true)
      const next = movePlayer(start, direction)
      expect(Math.abs(next.x - start.x) + Math.abs(next.y - start.y)).toBe(1)
    }
  })

  it('leaves the position unchanged at water, mountain, or world boundaries', () => {
    for (const direction of ['north', 'south', 'west', 'east'] as const) {
      const start = landWithNeighbor(direction, false)
      expect(movePlayer(start, direction)).toBe(start)
    }
  })
})
