import { describe, expect, it } from 'vitest'
import { isTraversable } from './playerPosition'
import { movementBlockTerrain, MOVEMENT_BLOCK_SIZE, MOVEMENT_WORLD, terrainAt, terrainIsWalkable } from './terrain'

// Exhaustive per-pixel sweep; kept out of the critical PR suite for speed.
describe('movement block collision', () => {
  it('matches collision to all 64 pixels of every movement block', () => {
    for (let blockY = 0; blockY < MOVEMENT_WORLD.height; blockY += 1) {
      for (let blockX = 0; blockX < MOVEMENT_WORLD.width; blockX += 1) {
        const pixels: ReturnType<typeof terrainAt>[] = []
        for (let y = blockY * MOVEMENT_BLOCK_SIZE; y < (blockY + 1) * MOVEMENT_BLOCK_SIZE; y += 1) {
          for (let x = blockX * MOVEMENT_BLOCK_SIZE; x < (blockX + 1) * MOVEMENT_BLOCK_SIZE; x += 1) {
            pixels.push(terrainAt(x, y))
          }
        }
        expect(isTraversable({ x: blockX, y: blockY })).toBe(pixels.every(terrainIsWalkable))
        expect(terrainIsWalkable(movementBlockTerrain(blockX, blockY))).toBe(pixels.every(terrainIsWalkable))
      }
    }
  }, 30_000)
})
