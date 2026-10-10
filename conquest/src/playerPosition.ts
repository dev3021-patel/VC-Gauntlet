import { browserStorage, type StorageLike } from './session/storage'
import { movementBlockTerrain, terrainIsWalkable, MOVEMENT_WORLD } from './terrain'

export type PlayerPosition = Readonly<{ x: number; y: number }>
export type MoveDirection = 'north' | 'south' | 'west' | 'east'

export const PLAYER_POSITION_STORAGE_PREFIX = 'party-conquest.position.'
export const PLAYER_POSITION_STORAGE_VERSION = 3

const MOVE_OFFSETS: Record<MoveDirection, PlayerPosition> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
  east: { x: 1, y: 0 },
}

let landCells: PlayerPosition[] | null = null

export function isTraversable(position: PlayerPosition): boolean {
  return Number.isInteger(position.x) && Number.isInteger(position.y) &&
    position.x >= 0 && position.x < MOVEMENT_WORLD.width && position.y >= 0 && position.y < MOVEMENT_WORLD.height &&
    terrainIsWalkable(movementBlockTerrain(position.x, position.y))
}

export function loadPlayerPosition(playerId: string, storage: StorageLike | null = browserStorage()): PlayerPosition | null {
  try {
    const raw = storage?.getItem(`${PLAYER_POSITION_STORAGE_PREFIX}${encodeURIComponent(playerId)}`)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PlayerPosition> & { version?: unknown }
    if (value.version !== PLAYER_POSITION_STORAGE_VERSION) return null
    const position = { x: value.x, y: value.y }
    return typeof position.x === 'number' && typeof position.y === 'number' && isTraversable(position as PlayerPosition)
      ? position as PlayerPosition
      : null
  } catch {
    return null
  }
}

export function savePlayerPosition(playerId: string, position: PlayerPosition, storage: StorageLike | null = browserStorage()): boolean {
  try {
    if (!storage) return false
    const key = `${PLAYER_POSITION_STORAGE_PREFIX}${encodeURIComponent(playerId)}`
    const serialized = JSON.stringify({ version: PLAYER_POSITION_STORAGE_VERSION, ...position })
    storage.setItem(key, serialized)
    return storage.getItem(key) === serialized
  } catch {
    return false
  }
}

export function randomSpawn(random: () => number = Math.random): PlayerPosition {
  if (!landCells) {
    landCells = []
    for (let y = 0; y < MOVEMENT_WORLD.height; y += 1) {
      for (let x = 0; x < MOVEMENT_WORLD.width; x += 1) {
        if (terrainIsWalkable(movementBlockTerrain(x, y))) landCells.push({ x, y })
      }
    }
  }
  return landCells[Math.min(landCells.length - 1, Math.floor(Math.max(0, random()) * landCells.length))]
}

export function movePlayer(position: PlayerPosition, direction: MoveDirection): PlayerPosition {
  const offset = MOVE_OFFSETS[direction]
  const candidate = { x: position.x + offset.x, y: position.y + offset.y }
  return isTraversable(candidate) ? candidate : position
}

export function directionForKey(key: string): MoveDirection | null {
  const normalized = key.length === 1 ? key.toLowerCase() : key
  return ({ w: 'north', ArrowUp: 'north', s: 'south', ArrowDown: 'south', a: 'west', ArrowLeft: 'west', d: 'east', ArrowRight: 'east' } as Record<string, MoveDirection>)[normalized] ?? null
}
