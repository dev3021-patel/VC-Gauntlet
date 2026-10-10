import { describe, expect, it } from 'vitest'
import { LOCAL_BACKEND_URL, resolveBackendUrl } from './backend'

describe('resolveBackendUrl', () => {
  it('uses the local backend during development', () => {
    expect(resolveBackendUrl({ DEV: true })).toBe(LOCAL_BACKEND_URL)
  })

  it('uses the local backend in builds unless configured', () => {
    expect(resolveBackendUrl({ DEV: false })).toBe(LOCAL_BACKEND_URL)
  })

  it('prefers an explicit VITE_BACKEND_URL and strips trailing slashes', () => {
    expect(resolveBackendUrl({ DEV: true, VITE_BACKEND_URL: 'https://example.test/api/' })).toBe(
      'https://example.test/api',
    )
  })

  it('ignores a blank VITE_BACKEND_URL', () => {
    expect(resolveBackendUrl({ DEV: false, VITE_BACKEND_URL: '   ' })).toBe(LOCAL_BACKEND_URL)
  })
})
