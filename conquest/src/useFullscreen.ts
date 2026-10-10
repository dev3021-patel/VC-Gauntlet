import { useCallback, useEffect, useState } from 'react'

function currentlyFullscreen() {
  return typeof document !== 'undefined' && document.fullscreenElement !== null && document.fullscreenElement !== undefined
}

export function fullscreenSupported() {
  return typeof document !== 'undefined'
    && document.fullscreenEnabled !== false
    && typeof document.documentElement?.requestFullscreen === 'function'
}

/**
 * Tracks the browser's actual fullscreen state and exposes a user-initiated
 * toggle. Rejections (unsupported, denied, not triggered by a user gesture)
 * surface as a short error message and never affect gameplay.
 */
export function useFullscreen() {
  const [active, setActive] = useState(currentlyFullscreen)
  const [error, setError] = useState<string | null>(null)
  const supported = fullscreenSupported()

  useEffect(() => {
    const syncState = () => setActive(currentlyFullscreen())
    document.addEventListener('fullscreenchange', syncState)
    document.addEventListener('fullscreenerror', syncState)
    return () => {
      document.removeEventListener('fullscreenchange', syncState)
      document.removeEventListener('fullscreenerror', syncState)
    }
  }, [])

  const toggle = useCallback(async () => {
    setError(null)
    if (!supported) {
      setError('Fullscreen is not available in this browser.')
      return
    }
    try {
      if (currentlyFullscreen()) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      setError('Fullscreen was blocked by the browser.')
    } finally {
      setActive(currentlyFullscreen())
    }
  }, [supported])

  return { active, supported, error, toggle }
}
