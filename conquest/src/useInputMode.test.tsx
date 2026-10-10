// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TOUCH_INPUT_QUERY, detectInputMode, useInputMode } from './useInputMode'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useInputMode', () => {
  it('reports a pointer device when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(detectInputMode()).toBe('pointer')
    const { result } = renderHook(() => useInputMode())
    expect(result.current).toBe('pointer')
  })

  it('reports touch for coarse pointers and follows media query changes', () => {
    let listener: ((event: { matches: boolean }) => void) | null = null
    const matchMedia = vi.fn((query: string) => ({
      matches: query === TOUCH_INPUT_QUERY,
      addEventListener: (_type: string, next: (event: { matches: boolean }) => void) => { listener = next },
      removeEventListener: vi.fn(),
    }))
    vi.stubGlobal('matchMedia', matchMedia)
    const { result, unmount } = renderHook(() => useInputMode())
    expect(result.current).toBe('touch')
    expect(matchMedia).toHaveBeenCalledWith(TOUCH_INPUT_QUERY)

    act(() => listener?.({ matches: false }))
    expect(result.current).toBe('pointer')
    act(() => listener?.({ matches: true }))
    expect(result.current).toBe('touch')
    unmount()
  })

  it('tolerates matchMedia stubs without change listeners', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { result } = renderHook(() => useInputMode())
    expect(result.current).toBe('touch')
  })
})
