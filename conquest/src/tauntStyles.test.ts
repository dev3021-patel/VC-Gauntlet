import { describe, expect, it } from 'vitest'
// The app compiler intentionally excludes Node globals; this test alone reads a source fixture.
// @ts-expect-error Node types are deliberately not enabled for browser production code.
import { readFileSync } from 'node:fs'
import { TAUNT_MS } from './useWorldSync'

const styles: string = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('taunt styles', () => {
  it('buzzes vertically for the taunt duration', () => {
    expect(styles).toContain(`.player-marker-visual--taunting { animation: player-taunt ${TAUNT_MS}ms linear; }`)
    expect(styles).toMatch(/@keyframes player-taunt \{[^}]*translateY/)
  })

  it('swaps the buzz for a non-moving pulse under reduced motion', () => {
    const reduced = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce) {\n  .player-marker-visual--taunting'))
    expect(reduced).toMatch(/^@media[^{]*\{\s*\.player-marker-visual--taunting\s*\{\s*animation:\s*player-taunt-pulse\b/)
    const pulse = styles.slice(styles.indexOf('@keyframes player-taunt-pulse'), styles.indexOf('}\n}', styles.indexOf('@keyframes player-taunt-pulse')))
    expect(pulse).not.toMatch(/transform|translate/)
  })
})
