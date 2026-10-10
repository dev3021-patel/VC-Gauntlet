import { describe, expect, it } from 'vitest'
// The app compiler intentionally excludes Node globals; this test alone reads a source fixture.
// @ts-expect-error Node types are deliberately not enabled for browser production code.
import { readFileSync } from 'node:fs'

const styles: string = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  // Anchor to a line start so `.avatar-md {` does not match `... > .avatar-md {` fragments.
  const start = styles.indexOf(`\n${selector} {`)
  expect(start, `${selector} rule exists`).toBeGreaterThan(-1)
  return styles.slice(start, styles.indexOf('}', start))
}

// Exact sizes, colors, and arrow geometry are visual choices; MapCanvas tests cover which direction class is applied.
describe('player facing indicator styles', () => {
  const indicator = rule('.facing-indicator')

  it('never intercepts input, contributes layout size, or covers the avatar', () => {
    expect(indicator).toMatch(/pointer-events:\s*none;/)
    expect(indicator).toMatch(/position:\s*absolute;/)
    // Inside the .player-marker stacking context a negative z-index paints under the
    // in-flow avatar (Issue #74).
    expect(indicator).toMatch(/z-index:\s*-1;/)
    expect(rule('.player-marker')).toMatch(/z-index:\s*2;/)
  })

  it('rotates the arrow to match each facing direction', () => {
    expect(rule('.facing-indicator--north')).not.toMatch(/rotate:/)
    expect(rule('.facing-indicator--east')).toMatch(/rotate:\s*90deg;/)
    expect(rule('.facing-indicator--south')).toMatch(/rotate:\s*180deg;/)
    expect(rule('.facing-indicator--west')).toMatch(/rotate:\s*270deg;/)
  })
})
