/**
 * Configuration for a command-point ledger.
 *
 * All durations and timestamps are expressed in epoch milliseconds. Command
 * points are awarded in `pointsPerInterval` batches for each fully elapsed
 * `intervalMs` period.
 */
export type CommandPointConfig = Readonly<{
  pointsPerInterval: number
  intervalMs: number
  cap: number
  startingPoints: number
}>

/** Plain, serializable command-point state. */
export type CommandPointLedger = Readonly<{
  points: number
  accruedThrough: number
}>

/** Result of settling and then attempting an atomic spend. */
export type CommandPointSpendResult = Readonly<{
  success: boolean
  state: CommandPointLedger
}>

/** The state and configuration produced by a timed configuration change. */
export type CommandPointReconfigurationResult = Readonly<{
  state: CommandPointLedger
  config: CommandPointConfig
}>

export type CommandPointErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_STATE'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_SPEND'
  | 'TIMESTAMP_BEFORE_ACCRUAL'

/** A domain validation error with a stable, machine-readable code. */
export class CommandPointError extends RangeError {
  readonly code: CommandPointErrorCode

  constructor(code: CommandPointErrorCode, message: string) {
    super(message)
    this.name = 'CommandPointError'
    this.code = code
  }
}

function isNonNegativeSafeInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0
}

function validateTimestamp(timestamp: number, name: string) {
  if (!isNonNegativeSafeInteger(timestamp)) {
    throw new CommandPointError(
      'INVALID_TIMESTAMP',
      `${name} must be a non-negative safe-integer epoch-millisecond timestamp`,
    )
  }
}

/** Validate a configuration independently of any ledger state. */
export function validateCommandPointConfig(config: CommandPointConfig): void {
  if (!isPositiveSafeInteger(config.pointsPerInterval)) {
    throw new CommandPointError(
      'INVALID_CONFIG',
      'pointsPerInterval must be a positive safe integer',
    )
  }
  if (!isPositiveSafeInteger(config.intervalMs)) {
    throw new CommandPointError('INVALID_CONFIG', 'intervalMs must be a positive safe integer')
  }
  if (!isNonNegativeSafeInteger(config.cap)) {
    throw new CommandPointError('INVALID_CONFIG', 'cap must be a non-negative safe integer')
  }
  if (!isNonNegativeSafeInteger(config.startingPoints)) {
    throw new CommandPointError(
      'INVALID_CONFIG',
      'startingPoints must be a non-negative safe integer',
    )
  }
  if (config.startingPoints > config.cap) {
    throw new CommandPointError('INVALID_CONFIG', 'startingPoints must not exceed cap')
  }
}

/** Validate persisted state against the configuration under which it is used. */
export function validateCommandPointLedger(
  state: CommandPointLedger,
  config: CommandPointConfig,
): void {
  if (!isNonNegativeSafeInteger(state.points)) {
    throw new CommandPointError('INVALID_STATE', 'state.points must be a non-negative safe integer')
  }
  if (state.points > config.cap) {
    throw new CommandPointError('INVALID_STATE', 'state.points must not exceed the active cap')
  }
  if (!isNonNegativeSafeInteger(state.accruedThrough)) {
    throw new CommandPointError(
      'INVALID_STATE',
      'state.accruedThrough must be a non-negative safe-integer epoch-millisecond timestamp',
    )
  }
}

/** Create a ledger at an explicit epoch-millisecond timestamp. */
export function initializeCommandPoints(
  config: CommandPointConfig,
  accruedThrough: number,
): CommandPointLedger {
  validateCommandPointConfig(config)
  validateTimestamp(accruedThrough, 'accruedThrough')

  return { points: config.startingPoints, accruedThrough }
}

/**
 * Settle all fully elapsed intervals through `now` without reading wall-clock
 * time. Partial progress is retained below the cap and discarded at the cap.
 */
export function settleCommandPoints(
  state: CommandPointLedger,
  config: CommandPointConfig,
  now: number,
): CommandPointLedger {
  validateCommandPointConfig(config)
  validateCommandPointLedger(state, config)
  validateTimestamp(now, 'now')

  if (now < state.accruedThrough) {
    throw new CommandPointError(
      'TIMESTAMP_BEFORE_ACCRUAL',
      'now must not be earlier than state.accruedThrough',
    )
  }

  if (state.points === config.cap) {
    return { points: state.points, accruedThrough: now }
  }

  const elapsedMs = now - state.accruedThrough
  const completedIntervals = Math.floor(elapsedMs / config.intervalMs)

  if (completedIntervals === 0) {
    return { ...state }
  }

  const pointsNeededToCap = config.cap - state.points
  const intervalsNeededToCap = Math.ceil(pointsNeededToCap / config.pointsPerInterval)

  // Compare before multiplying: the theoretical gain may exceed MAX_SAFE_INTEGER.
  if (completedIntervals >= intervalsNeededToCap) {
    return { points: config.cap, accruedThrough: now }
  }

  const gain = completedIntervals * config.pointsPerInterval
  const settledThrough = state.accruedThrough + completedIntervals * config.intervalMs

  return {
    points: state.points + gain,
    accruedThrough: settledThrough,
  }
}

/** Settle through `now`, then atomically spend a positive whole-point amount. */
export function spendCommandPoints(
  state: CommandPointLedger,
  config: CommandPointConfig,
  amount: number,
  now: number,
): CommandPointSpendResult {
  if (!isPositiveSafeInteger(amount)) {
    throw new CommandPointError('INVALID_SPEND', 'amount must be a positive safe integer')
  }

  const settled = settleCommandPoints(state, config, now)

  if (amount > settled.points) {
    return { success: false, state: settled }
  }

  return {
    success: true,
    state: { ...settled, points: settled.points - amount },
  }
}

/**
 * Settle with the old configuration through `effectiveAt`, then switch to the
 * new configuration. Old partial progress is discarded and lower caps clamp
 * immediately; increases never backfill.
 */
export function reconfigureCommandPoints(
  state: CommandPointLedger,
  currentConfig: CommandPointConfig,
  nextConfig: CommandPointConfig,
  effectiveAt: number,
): CommandPointReconfigurationResult {
  // Validate both configurations before calculating an intermediate result.
  validateCommandPointConfig(currentConfig)
  validateCommandPointConfig(nextConfig)
  const settled = settleCommandPoints(state, currentConfig, effectiveAt)

  return {
    config: { ...nextConfig },
    state: {
      points: Math.min(settled.points, nextConfig.cap),
      accruedThrough: effectiveAt,
    },
  }
}
