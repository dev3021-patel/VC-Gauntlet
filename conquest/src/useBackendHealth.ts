import { useEffect, useState } from 'react'
import { fetchBackendHealth } from './backend'

export type BackendStatus =
  | { state: 'checking' }
  | { state: 'online'; version: string }
  | { state: 'offline' }

/** Probes the backend once on mount and reports whether it answered. */
export function useBackendHealth(): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>({ state: 'checking' })

  useEffect(() => {
    const controller = new AbortController()
    fetchBackendHealth(controller.signal)
      .then((health) => setStatus({ state: 'online', version: health.version }))
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ state: 'offline' })
      })
    return () => controller.abort()
  }, [])

  return status
}
