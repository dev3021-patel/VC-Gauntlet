import { useCallback, useEffect, useState } from 'react'
import { loadPlayerPosition, movePlayer, randomSpawn, savePlayerPosition, type MoveDirection, type PlayerPosition } from './playerPosition'
import type { StorageLike } from './session/storage'

export function usePlayerPosition(playerId: string | null, storage?: StorageLike | null) {
  const [stored, setStored] = useState<{ playerId: string; position: PlayerPosition } | null>(null)
  const position = stored?.playerId === playerId ? stored.position : null

  useEffect(() => {
    if (!playerId) {
      setStored(null)
      return
    }
    const restored = loadPlayerPosition(playerId, storage)
    const initial = restored ?? randomSpawn()
    savePlayerPosition(playerId, initial, storage)
    setStored({ playerId, position: initial })
  }, [playerId, storage])

  const move = useCallback((direction: MoveDirection) => {
    if (!playerId) return
    setStored((current) => {
      if (!current || current.playerId !== playerId) return current
      const next = movePlayer(current.position, direction)
      if (next !== current.position) savePlayerPosition(playerId, next, storage)
      return next === current.position ? current : { playerId, position: next }
    })
  }, [playerId, storage])

  return { position, move }
}
