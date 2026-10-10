import { expect, it } from 'vitest'
// The app compiler intentionally excludes Node globals; this test alone reads a source fixture.
// @ts-expect-error Node types are deliberately not enabled for browser production code.
import { readFileSync } from 'node:fs'

it('keeps reduced-motion smoke stationary while retaining its fade', () => {
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  const smokeRuleIndex = styles.indexOf('spawn-smoke-fade 600ms')
  const reducedMotionRules = styles.slice(
    styles.lastIndexOf('@media (prefers-reduced-motion: reduce)', smokeRuleIndex),
    styles.indexOf('@keyframes spawn-smoke-fade', smokeRuleIndex),
  )
  expect(reducedMotionRules).toContain('spawn-smoke-fade 600ms linear forwards')
  expect(reducedMotionRules).toMatch(/\.spawn-smoke-puff\s*\{[^}]*animation:\s*none;[^}]*translate:\s*var\(--smoke-x\) var\(--smoke-y\)/)
})
