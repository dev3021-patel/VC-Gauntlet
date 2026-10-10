import { useEffect, useState } from 'react'

export type InputMode = 'touch' | 'pointer'

/**
 * Mirrors the stylesheet's mobile breakpoint so the virtual control pad and
 * the HUD layout agree on when a device is treated as touch-first. Party app
 * webviews and phone browsers report a coarse pointer; narrow desktop windows
 * fall under the width clause.
 */
export const TOUCH_INPUT_QUERY = '(pointer: coarse), (max-width: 680px)'

type MediaQueryLike = {
  matches: boolean
  addEventListener?: (type: 'change', listener: (event: { matches: boolean }) => void) => void
  removeEventListener?: (type: 'change', listener: (event: { matches: boolean }) => void) => void
}

function queryTouchInput(): MediaQueryLike | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(TOUCH_INPUT_QUERY) as MediaQueryLike
}

export function detectInputMode(): InputMode {
  return queryTouchInput()?.matches ? 'touch' : 'pointer'
}

/** Current input mode, re-evaluated when the media query flips (rotation, resize, docking a keyboard). */
export function useInputMode(): InputMode {
  const [mode, setMode] = useState<InputMode>(detectInputMode)

  useEffect(() => {
    const query = queryTouchInput()
    if (!query || typeof query.addEventListener !== 'function') return
    const update = (event: { matches: boolean }) => setMode(event.matches ? 'touch' : 'pointer')
    query.addEventListener('change', update)
    setMode(query.matches ? 'touch' : 'pointer')
    return () => query.removeEventListener?.('change', update)
  }, [])

  return mode
}
