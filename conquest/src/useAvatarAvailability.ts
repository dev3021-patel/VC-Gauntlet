import { useCallback, useEffect, useState } from 'react'
import { fetchAvatarsInUse } from './session/api'

export const AVATAR_AVAILABILITY_POLL_MS = 4000

/**
 * Built-in avatars held by other connected players, polled while a picker is open.
 * Presence is server state (connection leases), so polling picks up connects,
 * disconnects, and avatar changes. A failed poll keeps the last known list; the
 * server still rejects a conflicting claim.
 */
export function useAvatarAvailability(worldId: string, enabled: boolean, ownPlayerId: string | null, fetchImpl: typeof fetch = fetch) {
  const [held, setHeld] = useState<Record<string, string>>({})
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let controller: AbortController | null = null
    const poll = () => {
      controller?.abort()
      controller = new AbortController()
      fetchAvatarsInUse(worldId, fetchImpl, controller.signal)
        .then((next) => { if (!cancelled) setHeld(next) })
        .catch(() => { /* Keep the last known availability. */ })
    }
    poll()
    const timer = window.setInterval(poll, AVATAR_AVAILABILITY_POLL_MS)
    return () => {
      cancelled = true
      controller?.abort()
      window.clearInterval(timer)
    }
  }, [attempt, enabled, fetchImpl, worldId])

  const inUse = useCallback((avatar: string) => held[avatar] !== undefined && held[avatar] !== ownPlayerId, [held, ownPlayerId])
  /** Re-polls immediately, e.g. after the server rejected a claim. */
  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  return { inUse, refresh }
}
