import layout from '../backend/app/map-layout.json'

// One block-aligned layout is shipped to both the browser and backend image.
export const MOVEMENT_BLOCK_SIZE = layout.movementBlockSize
export const MOVEMENT_WORLD = { width: layout.rows[0].length, height: layout.rows.length } as const
export const WORLD = {
  width: MOVEMENT_WORLD.width * MOVEMENT_BLOCK_SIZE,
  height: MOVEMENT_WORLD.height * MOVEMENT_BLOCK_SIZE,
} as const
export type Terrain = 'water' | 'land' | 'tree' | 'barricade' | 'bridge' | 'wall' | 'courtyard'

export function terrainIsWalkable(terrain: Terrain): boolean {
  return terrain === 'land' || terrain === 'bridge' || terrain === 'courtyard'
}

export function movementBlockTerrain(x: number, y: number): Terrain {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
      x >= MOVEMENT_WORLD.width || y >= MOVEMENT_WORLD.height) return 'water'
  return layout.legend[layout.rows[y][x] as keyof typeof layout.legend] as Terrain
}

export function terrainAt(x: number, y: number): Terrain {
  return movementBlockTerrain(Math.floor(x / MOVEMENT_BLOCK_SIZE), Math.floor(y / MOVEMENT_BLOCK_SIZE))
}

export function movementBlockCenter(blockX: number, blockY: number) {
  return {
    x: blockX * MOVEMENT_BLOCK_SIZE + MOVEMENT_BLOCK_SIZE / 2,
    y: blockY * MOVEMENT_BLOCK_SIZE + MOVEMENT_BLOCK_SIZE / 2,
  }
}
