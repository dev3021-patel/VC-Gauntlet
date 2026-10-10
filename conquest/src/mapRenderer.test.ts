import { describe, expect, it } from 'vitest'
import { barricadeOverlay, getGridStep, MIN_GRID_ZOOM, treeOverlay } from './mapRenderer'
import { MOVEMENT_BLOCK_SIZE, movementBlockTerrain, WORLD } from './terrain'

describe('map grid alignment and stepping', () => {
  it('returns one movement-block grid step at gameplay zoom', () => {
    expect(getGridStep(1.5)).toBe(MOVEMENT_BLOCK_SIZE)
    expect(getGridStep(5)).toBe(MOVEMENT_BLOCK_SIZE)
    expect(getGridStep(32)).toBe(MOVEMENT_BLOCK_SIZE)
  })

  it('hides the grid below the minimum zoom instead of coarsening it', () => {
    expect(MIN_GRID_ZOOM).toBe(1.5)
    for (const zoom of [0.35, 0.5, 0.75, 1.0, 1.49]) {
      expect(getGridStep(zoom)).toBeNull()
    }
  })

  it('never draws anything but atomic movement cells', () => {
    const testZooms = [0.35, 0.5, 0.75, 1.0, 1.49, 1.5, 2.0, 4.99, 5.0, 10.0, 32.0]
    for (const zoom of testZooms) {
      const step = getGridStep(zoom)
      expect([null, MOVEMENT_BLOCK_SIZE]).toContain(step)
    }
    expect(WORLD.width % MOVEMENT_BLOCK_SIZE).toBe(0)
    expect(WORLD.height % MOVEMENT_BLOCK_SIZE).toBe(0)
  })

  it('restores the same atomic grid when zooming back across the threshold', () => {
    const steps = [2, 1.2, 1.5, 0.5, 3].map(getGridStep)
    expect(steps).toEqual([MOVEMENT_BLOCK_SIZE, null, MOVEMENT_BLOCK_SIZE, null, MOVEMENT_BLOCK_SIZE])
  })
})

const BRIDGE = new Set(['#b59260', '#755437', '#e2c491'])
const WALL = new Set(['#39464b', '#9ca9ad', '#63747a', '#d4d9cc'])

function colorsOf(overlay: (string | null)[][]) {
  return new Set(overlay.flat().filter((color): color is string => color !== null))
}

describe('recognizable trees and barricades', () => {
  it('draws trees inside their grass cell without bridge or wall colors', () => {
    const tree = { x: 4, y: 5 }
    expect(movementBlockTerrain(tree.x, tree.y)).toBe('tree')
    const overlay = treeOverlay(tree.x, tree.y)
    expect(overlay).toHaveLength(MOVEMENT_BLOCK_SIZE)
    expect(overlay[0]).toHaveLength(MOVEMENT_BLOCK_SIZE)
    const grass = overlay.flat().filter((color) => color === null).length
    expect(grass).toBeGreaterThanOrEqual(8)
    // Palette and pixel layout are art choices; trees must only read as distinct from bridges and walls.
    for (const color of colorsOf(overlay)) {
      expect(BRIDGE.has(color)).toBe(false)
      expect(WALL.has(color)).toBe(false)
    }
  })

  it('draws barricades that join across a horizontal pair without bridge, wall, or tree colors', () => {
    const left = { x: 48, y: 46 }
    const right = { x: 49, y: 46 }
    const isolated = { x: 70, y: 6 }
    expect(movementBlockTerrain(left.x, left.y)).toBe('barricade')
    expect(movementBlockTerrain(right.x, right.y)).toBe('barricade')
    expect(movementBlockTerrain(isolated.x, isolated.y)).toBe('barricade')

    const leftArt = barricadeOverlay(left.x, left.y)
    const rightArt = barricadeOverlay(right.x, right.y)
    const alone = barricadeOverlay(isolated.x, isolated.y)
    const cross = '#2a140c'
    const post = '#3e2412'

    // Neighbor-aware joining is behavior; spike color and log pixel patterns are art choices.
    expect(leftArt[3][7]).toBe(cross)
    expect(rightArt[3][0]).toBe(cross)
    expect(leftArt[3][0]).toBe(post)
    expect(rightArt[3][7]).toBe(post)
    expect(alone[3][0]).toBe(post)
    expect(alone[3][7]).toBe(post)
    const tree = colorsOf(treeOverlay(4, 5))
    for (const color of colorsOf(alone)) {
      expect(BRIDGE.has(color)).toBe(false)
      expect(WALL.has(color)).toBe(false)
      expect(tree.has(color)).toBe(false)
    }
  })
})
