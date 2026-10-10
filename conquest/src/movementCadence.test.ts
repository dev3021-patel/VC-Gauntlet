import { describe, expect, it } from 'vitest'
import { MAX_MOVES_IN_FLIGHT, MOVE_REPEAT_MS } from './movementCadence'

describe('movement cadence', () => {
  it('uses one standard speed for every player', () => {
    expect(MOVE_REPEAT_MS).toBe(80)
  })

  it('pipelines one move beyond the move being confirmed', () => {
    expect(MAX_MOVES_IN_FLIGHT).toBe(2)
  })
})
