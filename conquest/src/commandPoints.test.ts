import { describe, expect, it } from 'vitest'
import {
  CommandPointError,
  initializeCommandPoints,
  reconfigureCommandPoints,
  settleCommandPoints,
  spendCommandPoints,
  type CommandPointConfig,
  type CommandPointLedger,
} from './commandPoints'

const config: CommandPointConfig = {
  pointsPerInterval: 2,
  intervalMs: 1_000,
  cap: 10,
  startingPoints: 3,
}

describe('command-point initialization', () => {
  it('uses the starting grant and caller-supplied epoch-millisecond timestamp', () => {
    expect(initializeCommandPoints(config, 25_000)).toEqual({
      points: 3,
      accruedThrough: 25_000,
    })
  })

  it('supports a zero cap and zero starting grant', () => {
    expect(initializeCommandPoints({ ...config, cap: 0, startingPoints: 0 }, 0)).toEqual({
      points: 0,
      accruedThrough: 0,
    })
  })
})

describe('command-point settlement', () => {
  it('preserves partial intervals and awards batches on exact boundaries', () => {
    const initial = initializeCommandPoints(config, 10_000)

    expect(settleCommandPoints(initial, config, 10_999)).toEqual(initial)
    expect(settleCommandPoints(initial, config, 11_000)).toEqual({
      points: 5,
      accruedThrough: 11_000,
    })
    expect(settleCommandPoints(initial, config, 12_750)).toEqual({
      points: 7,
      accruedThrough: 12_000,
    })
  })

  it('produces the same state for frequent and deferred settlement', () => {
    const initial = initializeCommandPoints(config, 0)
    const once = settleCommandPoints(initial, config, 3_750)
    const first = settleCommandPoints(initial, config, 450)
    const second = settleCommandPoints(first, config, 1_600)
    const frequent = settleCommandPoints(second, config, 3_750)

    expect(frequent).toEqual(once)
    expect(once).toEqual({ points: 9, accruedThrough: 3_000 })
  })

  it('clamps long offline accumulation without unsafe gain arithmetic', () => {
    const largeConfig: CommandPointConfig = {
      pointsPerInterval: Number.MAX_SAFE_INTEGER,
      intervalMs: 1,
      cap: Number.MAX_SAFE_INTEGER,
      startingPoints: 0,
    }

    expect(
      settleCommandPoints(
        { points: 0, accruedThrough: 0 },
        largeConfig,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toEqual({
      points: Number.MAX_SAFE_INTEGER,
      accruedThrough: Number.MAX_SAFE_INTEGER,
    })
  })

  it('discards elapsed time while already capped', () => {
    const capped = settleCommandPoints({ points: 10, accruedThrough: 1_000 }, config, 50_500)
    const spent = spendCommandPoints(capped, config, 2, 50_500)

    expect(capped).toEqual({ points: 10, accruedThrough: 50_500 })
    expect(spent).toEqual({
      success: true,
      state: { points: 8, accruedThrough: 50_500 },
    })
    expect(settleCommandPoints(spent.state, config, 51_499)).toEqual(spent.state)
  })

  it('discards extra intervals and partial progress when settlement reaches the cap', () => {
    const capped = settleCommandPoints({ points: 7, accruedThrough: 0 }, config, 10_500)
    const spent = spendCommandPoints(capped, config, 2, 10_500)

    expect(capped).toEqual({ points: 10, accruedThrough: 10_500 })
    expect(settleCommandPoints(spent.state, config, 11_499)).toEqual(spent.state)
  })

  it('accepts zero elapsed time and rejects clock rollback', () => {
    const state = { points: 4, accruedThrough: 5_000 }

    expect(settleCommandPoints(state, config, 5_000)).toEqual(state)
    expect(() => settleCommandPoints(state, config, 4_999)).toThrowError(
      expect.objectContaining({ code: 'TIMESTAMP_BEFORE_ACCRUAL' }),
    )
  })
})

describe('command-point spending', () => {
  it('settles first and deducts the entire affordable amount', () => {
    expect(spendCommandPoints({ points: 3, accruedThrough: 0 }, config, 5, 1_000)).toEqual({
      success: true,
      state: { points: 0, accruedThrough: 1_000 },
    })
  })

  it('does not deduct an unaffordable amount but returns settled state', () => {
    expect(spendCommandPoints({ points: 3, accruedThrough: 0 }, config, 6, 1_000)).toEqual({
      success: false,
      state: { points: 5, accruedThrough: 1_000 },
    })
  })
})

describe('command-point reconfiguration', () => {
  it('settles under the old rules, resets partial progress, and uses new rules going forward', () => {
    const nextConfig = { ...config, pointsPerInterval: 5, intervalMs: 500, cap: 20 }
    const changed = reconfigureCommandPoints(
      { points: 3, accruedThrough: 0 },
      config,
      nextConfig,
      1_750,
    )

    expect(changed).toEqual({
      config: nextConfig,
      state: { points: 5, accruedThrough: 1_750 },
    })
    expect(settleCommandPoints(changed.state, changed.config, 2_249)).toEqual(changed.state)
    expect(settleCommandPoints(changed.state, changed.config, 2_250)).toEqual({
      points: 10,
      accruedThrough: 2_250,
    })
  })

  it('immediately clamps a lower cap', () => {
    const changed = reconfigureCommandPoints(
      { points: 9, accruedThrough: 0 },
      config,
      { ...config, cap: 4, startingPoints: 4 },
      500,
    )

    expect(changed.state).toEqual({ points: 4, accruedThrough: 500 })
  })

  it('does not backfill after a cap increase', () => {
    const oldConfig = { ...config, cap: 5, startingPoints: 5 }
    const changed = reconfigureCommandPoints(
      { points: 5, accruedThrough: 0 },
      oldConfig,
      { ...config, cap: 20 },
      50_000,
    )

    expect(changed.state).toEqual({ points: 5, accruedThrough: 50_000 })
  })
})

describe('command-point validation', () => {
  const invalidNumbers = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]

  it.each(invalidNumbers)('rejects invalid non-negative configuration values: %s', (value) => {
    expect(() => initializeCommandPoints({ ...config, cap: value }, 0)).toThrow(CommandPointError)
    expect(() => initializeCommandPoints({ ...config, startingPoints: value }, 0)).toThrow(
      CommandPointError,
    )
  })

  it.each([...invalidNumbers, 0])('rejects invalid positive configuration values: %s', (value) => {
    expect(() => initializeCommandPoints({ ...config, pointsPerInterval: value }, 0)).toThrow(
      CommandPointError,
    )
    expect(() => initializeCommandPoints({ ...config, intervalMs: value }, 0)).toThrow(
      CommandPointError,
    )
  })

  it('rejects a starting grant above the cap', () => {
    expect(() => initializeCommandPoints({ ...config, startingPoints: 11 }, 0)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    )
  })

  it.each(invalidNumbers)('rejects invalid ledger points: %s', (points) => {
    expect(() => settleCommandPoints({ points, accruedThrough: 0 }, config, 0)).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    )
  })

  it('rejects a ledger balance above the active cap', () => {
    expect(() => settleCommandPoints({ points: 11, accruedThrough: 0 }, config, 0)).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    )
  })

  it.each(invalidNumbers)('rejects invalid state timestamps: %s', (accruedThrough) => {
    expect(() =>
      settleCommandPoints({ points: 1, accruedThrough }, config, 0),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))
  })

  it.each(invalidNumbers)('rejects invalid operation timestamps: %s', (now) => {
    expect(() => initializeCommandPoints(config, now)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TIMESTAMP' }),
    )
  })

  it.each([...invalidNumbers, 0])('rejects invalid spend amounts: %s', (amount) => {
    expect(() => spendCommandPoints({ points: 3, accruedThrough: 0 }, config, amount, 0)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SPEND' }),
    )
  })

  it('does not mutate caller-owned objects', () => {
    const state: CommandPointLedger = { points: 3, accruedThrough: 0 }
    const nextConfig = { ...config, cap: 8 }

    spendCommandPoints(state, config, 2, 1_000)
    reconfigureCommandPoints(state, config, nextConfig, 1_000)

    expect(state).toEqual({ points: 3, accruedThrough: 0 })
    expect(config).toEqual({ pointsPerInterval: 2, intervalMs: 1_000, cap: 10, startingPoints: 3 })
    expect(nextConfig).toEqual({ pointsPerInterval: 2, intervalMs: 1_000, cap: 8, startingPoints: 3 })
  })
})
