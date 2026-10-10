import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTraversable, loadPlayerPosition, type MoveDirection, type PlayerPosition } from './playerPosition'
import { browserStorage, type StorageLike } from './session/storage'
import { ApiError } from './session/api'
import type { AvatarId, Player } from './session/types'
import { commandId, submitWorldCommand, type WorldCommandResult } from './worldCommands'
import { LASER_COOLDOWN_MS, LASER_FLASH_MS } from './laser'
import { type SyncState, type WorldEvent, type WorldSyncOptions, WorldSynchronizer } from './worldSync'

export type SharedPlayer = PlayerPosition & {
  playerId: string
  name: string
  avatar: Player['avatar']
  positionRevision: number
  facing: MoveDirection
  firstSpawn?: boolean
}

export type SharedShot = {
  shotId: string
  shooterName?: string
  shooterId: string
  facing: MoveDirection
  origin: PlayerPosition
  path: PlayerPosition[]
  victim: SharedPlayer | null
  victims?: SharedPlayer[]
  /** Victims whose death the server committed; preferred over `victims` when present. */
  eliminatedVictims?: SharedPlayer[]
  /** The mob the laser stopped on, if any (at most one). */
  mobHits?: { mobId: string; x: number; y: number }[]
}

export type SpawnReveal = PlayerPosition & {
  id: string
  playerId: string
}

/** A server-controlled enemy. Health and position only ever come from committed world state. */
export type SharedMob = PlayerPosition & {
  mobId: string
  kind: string
  facing: MoveDirection
  health: number
  maxHealth: number
  revision: number
  /** Ranged mobs only: a visible wind-up precedes every shot. */
  windingUp?: boolean
}

/** A ranged mob's shot in flight, advanced by the server each tick until something stops it. */
export type MobProjectile = PlayerPosition & { id: string; mobId: string; facing: MoveDirection; distance: number; dx?: number; dy?: number }

function isMobProjectile(value: unknown): value is MobProjectile {
  const item = value as Partial<MobProjectile> | null
  return !!item && typeof item.id === 'string' && Number.isFinite(item.x) && Number.isFinite(item.y) &&
    typeof item.facing === 'string' && item.facing in OFFSETS && Number.isFinite(item.distance) &&
    (item.dx === undefined || Number.isFinite(item.dx)) && (item.dy === undefined || Number.isFinite(item.dy))
}

export type MobHit = SharedMob & { defeated: boolean }
export type MobAttack = { mobId: string; playerId: string; outcome: string }
export type MobDefeat = PlayerPosition & { id: string; mobId: string }
export const MOB_FEEDBACK_MS = 600
/** Length of the cosmetic taunt buzz (or reduced-motion pulse). */
export const TAUNT_MS = 500

export const MOVE_TIMEOUT_MS = 5000
const OFFSETS: Record<MoveDirection, PlayerPosition> = {
  north: { x: 0, y: -1 }, south: { x: 0, y: 1 }, west: { x: -1, y: 0 }, east: { x: 1, y: 0 },
}
const TERMINAL_PLACEMENT_ERRORS = new Set(['no_spawn_available', 'unauthorized', 'not_active', 'avatar_in_use'])
/** Events that publish one player's committed position. `player.respawned` is retained for replayed history. */
const POSITION_EVENTS = new Set(['player.placed', 'player.moved', 'player.respawned', 'player.faced'])

/** Name shown on the defeat screen; missing or blank attribution is omitted. */
export function displayName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

type AvatarUpdate = Pick<SharedPlayer, 'playerId' | 'avatar'>

function isAvatarUpdate(value: unknown): value is AvatarUpdate {
  const item = value as Partial<AvatarUpdate> | null
  return !!item && typeof item.playerId === 'string' && typeof item.avatar === 'string'
}

function isSharedPlayer(value: unknown): value is SharedPlayer {
  const item = value as Partial<SharedPlayer> | null
  return !!item && typeof item.playerId === 'string' && typeof item.name === 'string' && typeof item.avatar === 'string' &&
    Number.isInteger(item.x) && Number.isInteger(item.y) && Number.isInteger(item.positionRevision) &&
    typeof item.facing === 'string' && item.facing in OFFSETS
}

function isSharedShot(value: unknown): value is SharedShot {
  const shot = value as Partial<SharedShot> | null
  return !!shot && typeof shot.shotId === 'string' && typeof shot.shooterId === 'string' &&
    typeof shot.facing === 'string' && shot.facing in OFFSETS && !!shot.origin && Array.isArray(shot.path) &&
    (shot.victim == null || isSharedPlayer(shot.victim)) &&
    (shot.victims == null || (Array.isArray(shot.victims) && shot.victims.every(isSharedPlayer)))
}

function isSharedMob(value: unknown): value is SharedMob {
  const item = value as Partial<SharedMob> | null
  return !!item && typeof item.mobId === 'string' && typeof item.kind === 'string' && Number.isInteger(item.x) && Number.isInteger(item.y) &&
    typeof item.facing === 'string' && item.facing in OFFSETS && Number.isInteger(item.health) && Number.isInteger(item.maxHealth) &&
    Number.isInteger(item.revision)
}

function isMobHit(value: unknown): value is MobHit {
  return isSharedMob(value) && typeof (value as Partial<MobHit>).defeated === 'boolean'
}

function isMobAttack(value: unknown): value is MobAttack {
  const item = value as Partial<MobAttack> | null
  return !!item && typeof item.mobId === 'string' && typeof item.playerId === 'string'
}

function staleQueueKey(worldId: string, playerId: string) { return `party-conquest.moves.${worldId}.${playerId}` }

export function useWorldSync(
  worldId: string,
  options: {
    player: Player | null
    token: string | null
    storage?: StorageLike | null
    fetchImpl?: typeof fetch
    createSocket?: WorldSyncOptions['createSocket']
    minBackoffMs?: number
    maxBackoffMs?: number
  },
) {
  const { player, token, fetchImpl = fetch, createSocket, minBackoffMs, maxBackoffMs } = options
  const storage = options.storage === undefined ? browserStorage() : options.storage
  const [status, setStatus] = useState<{ state: SyncState; revision: number }>({ state: 'syncing', revision: 0 })
  const [players, setPlayers] = useState<Record<string, SharedPlayer>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [shot, setShot] = useState<SharedShot | null>(null)
  const [spawnReveals, setSpawnReveals] = useState<SpawnReveal[]>([])
  const [mobs, setMobs] = useState<Record<string, SharedMob>>({})
  const mobsRef = useRef(mobs)
  const mobRevisionsRef = useRef<Record<string, number>>({})
  const [mobHitIds, setMobHitIds] = useState<Record<string, number>>({})
  const [mobAttackIds, setMobAttackIds] = useState<Record<string, number>>({})
  const [mobDefeats, setMobDefeats] = useState<MobDefeat[]>([])
  const [mobProjectiles, setMobProjectiles] = useState<MobProjectile[]>([])
  // Player id -> taunt sequence; a fresh sequence restarts the animation.
  const [taunts, setTaunts] = useState<Record<string, number>>({})
  const mobTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const sharedMobs = useMemo(() => Object.values(mobs), [mobs])
  const [dead, setDead] = useState(false)
  const [attackerName, setAttackerName] = useState<string | null>(null)
  const [placementAttempt, setPlacementAttempt] = useState(0)
  const stateRef = useRef<SyncState>('syncing')
  const avatarUpdatesRef = useRef<Record<string, { revision: number; avatar: AvatarId }>>({})
  const playersRef = useRef(players)
  const playerIdRef = useRef(player?.id)
  playerIdRef.current = player?.id
  const tokenRef = useRef(token)
  tokenRef.current = token
  const connectedTokenRef = useRef(token)
  const synchronizerRef = useRef<WorldSynchronizer | null>(null)
  const entityRevisionsRef = useRef<Record<string, number>>({})
  const snapshotRevisionRef = useRef(0)
  const deathsRef = useRef<Record<string, number>>({})
  const attributionRef = useRef<Record<string, unknown>>({})
  const deathRevisionRef = useRef<number | null>(null)
  const rejoinRevisionRef = useRef<number | null>(null)
  // Moves in flight, oldest first. Up to `maxInFlight` moves pipeline so
  // confirmation latency does not cap the held-input rate. Each pipelined move
  // is sent against the predicted outcome of the previous one and the server
  // still validates every cell. The latest prediction is published for
  // presentation only; gameplay keeps reading confirmed positions.
  const pendingMovesRef = useRef<{ id: string; cancel: () => void; settled: Promise<void> }[]>([])
  const predictedPositionRef = useRef<{ x: number; y: number; positionRevision: number } | null>(null)
  const [predictedPosition, setPredictedPosition] = useState<PlayerPosition | null>(null)
  const predict = useCallback((next: { x: number; y: number; positionRevision: number } | null) => {
    predictedPositionRef.current = next
    setPredictedPosition(next && { x: next.x, y: next.y })
  }, [])
  const cancelMove = useCallback(() => {
    const pending = pendingMovesRef.current
    pendingMovesRef.current = []
    predict(null)
    pending.forEach((move) => move.cancel())
  }, [predict])
  const settleMove = useCallback((id: string) => {
    pendingMovesRef.current = pendingMovesRef.current.filter((move) => move.id !== id)
    if (pendingMovesRef.current.length === 0) predict(null)
  }, [predict])
  useEffect(() => cancelMove, [cancelMove, player?.id, token, worldId])
  const seenShotsRef = useRef(new Set<string>())
  const shotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const placingRef = useRef(false)
  const placementRejectedRef = useRef(false)
  // Set when the saved built-in avatar is held by another connected player (socket
  // handshake or a rejected placement); the player must choose another to continue.
  const [avatarConflict, setAvatarConflict] = useState(false)
  useEffect(() => setAvatarConflict(false), [player?.id, token, worldId])
  const revealTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const sharedPlayers = useMemo(() => Object.values(players), [players])
  /** Mark an entity for a short visual effect; a retrigger restarts it and outlives the earlier timer. */
  const flash = useCallback((setter: typeof setMobHitIds, id: string, durationMs = MOB_FEEDBACK_MS) => {
    let sequence = 0
    setter((current) => { sequence = (current[id] ?? 0) + 1; return { ...current, [id]: sequence } })
    const timer = setTimeout(() => {
      mobTimersRef.current.delete(timer)
      setter((current) => {
        if (current[id] !== sequence) return current
        const next = { ...current }
        delete next[id]
        return next
      })
    }, durationMs)
    mobTimersRef.current.add(timer)
  }, [])
  const applyEvent = useCallback((event: WorldEvent) => {
    const mobGuard = (mobId: string) => event.revision > Math.max(snapshotRevisionRef.current, mobRevisionsRef.current[mobId] ?? 0)
    const applyMobHits = (value: unknown) => {
      if (!Array.isArray(value)) return
      const hits = value.filter(isMobHit).filter((hit) => mobGuard(hit.mobId))
      if (!hits.length) return
      const remaining = { ...mobsRef.current }
      const defeats: MobDefeat[] = []
      for (const hit of hits) {
        mobRevisionsRef.current[hit.mobId] = event.revision
        if (hit.defeated) {
          delete remaining[hit.mobId]
          if (stateRef.current === 'connected') defeats.push({ id: `${event.commandId}:${hit.mobId}`, mobId: hit.mobId, x: hit.x, y: hit.y })
        } else {
          const { defeated: _defeated, ...mob } = hit
          remaining[hit.mobId] = mob
          if (stateRef.current === 'connected') flash(setMobHitIds, hit.mobId)
        }
      }
      mobsRef.current = remaining
      setMobs(remaining)
      if (defeats.length) {
        setMobDefeats((current) => [...current, ...defeats])
        const timer = setTimeout(() => {
          mobTimersRef.current.delete(timer)
          setMobDefeats((current) => current.filter((defeat) => !defeats.some((item) => item.id === defeat.id)))
        }, MOB_FEEDBACK_MS)
        mobTimersRef.current.add(timer)
      }
    }
    const applyMobPopulation = (value: unknown) => {
      // A tick carries the complete population, so absent mobs have been removed.
      if (!Array.isArray(value)) return
      const listed = value.filter(isSharedMob)
      const remaining = { ...mobsRef.current }
      for (const mob of listed) {
        if (!mobGuard(mob.mobId)) continue
        mobRevisionsRef.current[mob.mobId] = event.revision
        remaining[mob.mobId] = mob
      }
      const ids = new Set(listed.map((mob) => mob.mobId))
      for (const mobId of Object.keys(remaining)) {
        if (!ids.has(mobId) && mobGuard(mobId)) {
          mobRevisionsRef.current[mobId] = event.revision
          delete remaining[mobId]
        }
      }
      mobsRef.current = remaining
      setMobs(remaining)
    }
    const removeVictims = (victims: SharedPlayer[], attackerName?: string) => {
      const remaining = { ...playersRef.current }
      for (const victim of victims) {
        if (event.revision <= Math.max(snapshotRevisionRef.current, entityRevisionsRef.current[victim.playerId] ?? 0)) continue
        entityRevisionsRef.current[victim.playerId] = event.revision
        deathsRef.current[victim.playerId] = event.revision
        attributionRef.current[victim.playerId] = attackerName
        delete remaining[victim.playerId]
        if (victim.playerId === playerIdRef.current) {
          cancelMove()
          deathRevisionRef.current = event.revision
          setAttackerName(displayName(attackerName))
          setDead(true)
        }
      }
      playersRef.current = remaining
      setPlayers(remaining)
    }
    applyMobHits(event.payload.mobHits)
    if (event.eventType === 'mob.tick') {
      applyMobPopulation(event.payload.mobs)
      // Each tick carries every projectile in flight; older replays never rewind past the snapshot.
      if (Array.isArray(event.payload.projectiles) && event.revision > snapshotRevisionRef.current) {
        setMobProjectiles(event.payload.projectiles.filter(isMobProjectile))
      }
      const attacks = Array.isArray(event.payload.attacks) ? event.payload.attacks.filter(isMobAttack) : []
      if (stateRef.current === 'connected') attacks.forEach((attack) => flash(setMobAttackIds, attack.mobId))
      // Confirmed eliminations only; a revision-guarded death is applied once.
      if (Array.isArray(event.payload.eliminatedVictims)) {
        removeVictims(event.payload.eliminatedVictims.filter(isSharedPlayer), displayName(event.payload.attackerName) ?? undefined)
      }
      return
    }
    if (event.eventType === 'player.shot' && isSharedShot(event.payload)) {
      const next = event.payload
      if (seenShotsRef.current.has(next.shotId)) return
      seenShotsRef.current.add(next.shotId)
      setShot(next)
      // A laser is instantaneous: its flash fades on its own rather than lingering until the next shot.
      if (shotTimerRef.current) clearTimeout(shotTimerRef.current)
      shotTimerRef.current = setTimeout(() => {
        shotTimerRef.current = null
        setShot((current) => current?.shotId === next.shotId ? null : current)
      }, LASER_FLASH_MS)
      const confirmed = Array.isArray(next.eliminatedVictims) ? next.eliminatedVictims.filter(isSharedPlayer) : null
      removeVictims(confirmed ?? next.victims ?? (next.victim ? [next.victim] : []), next.shooterName)
      return
    }
    if (event.eventType === 'player.avatar_changed' && isAvatarUpdate(event.payload)) {
      const { playerId, avatar } = event.payload
      if (event.revision <= Math.max(snapshotRevisionRef.current, entityRevisionsRef.current[playerId] ?? 0,
        avatarUpdatesRef.current[playerId]?.revision ?? 0)) return
      avatarUpdatesRef.current[playerId] = { revision: event.revision, avatar }
      // A cosmetic update never recreates a defeated life or changes its death revision.
      const current = playersRef.current[playerId]
      if (current) {
        playersRef.current = { ...playersRef.current, [playerId]: { ...current, avatar } }
        setPlayers(playersRef.current)
      }
      return
    }
    if (!POSITION_EVENTS.has(event.eventType) || !isSharedPlayer(event.payload)) return
    const avatarUpdate = avatarUpdatesRef.current[event.payload.playerId]
    const next = avatarUpdate && avatarUpdate.revision > event.revision
      ? { ...event.payload, avatar: avatarUpdate.avatar } : event.payload
    if (event.revision <= Math.max(snapshotRevisionRef.current, entityRevisionsRef.current[next.playerId] ?? 0)) return
    delete deathsRef.current[next.playerId]
    delete attributionRef.current[next.playerId]
    entityRevisionsRef.current[next.playerId] = event.revision
    if (next.playerId === playerIdRef.current) {
      if (event.eventType === 'player.respawned') cancelMove()
      setDead(false)
      setAttackerName(null)
      deathRevisionRef.current = null
    }
    playersRef.current = { ...playersRef.current, [next.playerId]: next }
    setPlayers(playersRef.current)
    // Actual arrivals set firstSpawn (true on a first life, false after a death).
    // An already-active player.placed omits it.
    if (event.eventType === 'player.placed' && typeof next.firstSpawn === 'boolean' && stateRef.current === 'connected') {
      const reveal = { id: `${event.commandId}:${event.revision}`, playerId: next.playerId, x: next.x, y: next.y }
      setSpawnReveals((current) => [...current, reveal])
      const timer = setTimeout(() => {
        revealTimersRef.current.delete(timer)
        setSpawnReveals((current) => current.filter((item) => item.id !== reveal.id))
      }, 900)
      revealTimersRef.current.add(timer)
    }
  }, [cancelMove, flash])

  useEffect(() => {
    // Authentication can finish after the public world snapshot.
    deathRevisionRef.current = deathsRef.current[player?.id ?? ''] ?? null
    setDead(deathRevisionRef.current !== null)
    setAttackerName(displayName(attributionRef.current[player?.id ?? '']))
  }, [player?.id])

  useEffect(() => {
    if (!player) return
    try { storage?.removeItem(staleQueueKey(worldId, player.id)) } catch { /* Old queues are ignored regardless. */ }
  }, [player, storage, worldId])

  useEffect(() => {
    placingRef.current = false
    placementRejectedRef.current = false
  }, [player?.id, token, worldId])

  useEffect(() => {
    let revision = 0
    const synchronizer = new WorldSynchronizer({
      worldId, getToken: () => tokenRef.current, fetch: fetchImpl, createSocket, minBackoffMs, maxBackoffMs,
      onAvatarConflict: () => setAvatarConflict(true),
      onTaunt: ({ playerId: tauntingPlayerId }) => {
        if (stateRef.current === 'connected' && playersRef.current[tauntingPlayerId]) flash(setTaunts, tauntingPlayerId, TAUNT_MS)
      },
      onEvent: (event) => {
        revision = event.revision
        // HTTP results update visuals only; this stream supplies commit order and deduplication.
        applyEvent(event)
        const streamed = pendingMovesRef.current.find((move) => move.id === event.commandId)
        if (streamed) { settleMove(streamed.id); streamed.cancel() }
        setStatus((current) => ({ ...current, revision }))
      },
      onSnapshot: (snapshot) => {
        revision = snapshot.revision
        snapshotRevisionRef.current = revision
        entityRevisionsRef.current = {}
        avatarUpdatesRef.current = {}
        const eliminated = snapshot.state.eliminated as Record<string, number> | undefined
        deathsRef.current = eliminated ?? {}
        deathRevisionRef.current = eliminated?.[playerIdRef.current ?? ''] ?? null
        setDead(deathRevisionRef.current !== null)
        const attribution = snapshot.state.deathAttribution as Record<string, unknown> | undefined
        attributionRef.current = attribution ?? {}
        setAttackerName(displayName(attribution?.[playerIdRef.current ?? '']))
        const list = Array.isArray(snapshot.state.players) ? snapshot.state.players.filter(isSharedPlayer) : []
        playersRef.current = Object.fromEntries(list.map((item) => [item.playerId, item]))
        setPlayers(playersRef.current)
        // Hydration restores the current population only; no historical hits or attacks replay.
        mobRevisionsRef.current = {}
        const mobItems = Array.isArray(snapshot.state.mobs) ? snapshot.state.mobs.filter(isSharedMob) : []
        mobsRef.current = Object.fromEntries(mobItems.map((mob) => [mob.mobId, mob]))
        setMobs(mobsRef.current)
        setMobProjectiles(Array.isArray(snapshot.state.mobProjectiles) ? snapshot.state.mobProjectiles.filter(isMobProjectile) : [])
        setStatus((current) => ({ ...current, revision }))
      },
      onStateChange: (state) => {
        stateRef.current = state
        if (state !== 'connected') {
          cancelMove()
          setMessage(null)
          setTaunts({})
        }
        setStatus({ state, revision })
      },
    })
    synchronizerRef.current = synchronizer
    synchronizer.start()
    return () => {
      cancelMove()
      synchronizer.stop()
      if (shotTimerRef.current) clearTimeout(shotTimerRef.current)
      shotTimerRef.current = null
      revealTimersRef.current.forEach(clearTimeout)
      revealTimersRef.current.clear()
      setSpawnReveals([])
      mobTimersRef.current.forEach(clearTimeout)
      mobTimersRef.current.clear()
      setMobHitIds({})
      setMobAttackIds({})
      setMobDefeats([])
      setTaunts({})
    }
  }, [applyEvent, cancelMove, createSocket, fetchImpl, flash, maxBackoffMs, minBackoffMs, settleMove, worldId])

  useEffect(() => {
    if (connectedTokenRef.current !== token && stateRef.current === 'connected') {
      synchronizerRef.current?.forceResync()
    }
    connectedTokenRef.current = token
  }, [token])

  useEffect(() => {
    if (!player || !token || dead || (deathsRef.current[player.id] !== undefined && rejoinRevisionRef.current !== deathsRef.current[player.id]) || status.state !== 'connected' || playersRef.current[player.id] || placingRef.current || placementRejectedRef.current) return
    placingRef.current = true
    const suggestedPosition = loadPlayerPosition(player.id, storage)
    void submitWorldCommand(fetchImpl, worldId, token, 'player.place', { suggestedPosition, expectedDeathRevision: rejoinRevisionRef.current })
      .then(({ event }) => { if (stateRef.current === 'connected') applyEvent(event) })
      .catch((error: Error) => {
        placementRejectedRef.current = error instanceof ApiError && TERMINAL_PLACEMENT_ERRORS.has(error.code)
        if (error instanceof ApiError && error.code === 'avatar_in_use') {
          setAvatarConflict(true)
          return
        }
        if (stateRef.current === 'connected') setMessage(error.message)
        if (error instanceof ApiError && error.code === 'not_active') synchronizerRef.current?.forceResync()
      })
      .finally(() => { placingRef.current = false })
  }, [applyEvent, dead, fetchImpl, player, status.state, storage, token, worldId, placementAttempt])

  const move = useCallback((direction: MoveDirection, maxInFlight = 1) => {
    if (!player || !token || dead || stateRef.current !== 'connected') return
    // Moves and turns ride the open stream when the server offers it; HTTP remains the fallback.
    const live = synchronizerRef.current?.commandsAvailable ? synchronizerRef.current : null
    const submit = (actionType: string, payload: Record<string, unknown>, signal?: AbortSignal, id = commandId()): Promise<Pick<WorldCommandResult, 'event'>> =>
      live ? live.sendCommand(actionType, payload, id, signal) : submitWorldCommand(fetchImpl, worldId, token, actionType, payload, signal, id)
    if (pendingMovesRef.current.length >= Math.max(1, maxInFlight)) return
    const confirmed = playersRef.current[player.id]
    if (!confirmed) return
    const pipelined = pendingMovesRef.current.length > 0 && predictedPositionRef.current !== null
    const base = pipelined ? predictedPositionRef.current! : confirmed
    const offset = OFFSETS[direction]
    const destination = { x: base.x + offset.x, y: base.y + offset.y }
    if (!isTraversable(destination)) return
    const controller = new AbortController()
    let release = () => {}
    const settled = new Promise<void>((resolve) => { release = resolve })
    const pending = { id: commandId(), cancel: () => { clearTimeout(timer); controller.abort(); release() }, settled }
    const inFlight = () => pendingMovesRef.current.includes(pending)
    const timer = setTimeout(() => {
      if (!inFlight()) return
      cancelMove()
      synchronizerRef.current?.forceResync()
    }, MOVE_TIMEOUT_MS)
    pendingMovesRef.current = [...pendingMovesRef.current, pending]
    predict({ ...destination, positionRevision: base.positionRevision + 1 })
    setMessage(null)
    void submit('player.move', {
      expected: { x: base.x, y: base.y }, destination, expectedRevision: base.positionRevision,
    }, controller.signal, pending.id).then(({ event }) => {
      if (inFlight() && stateRef.current === 'connected') applyEvent(event)
    }).catch((error: Error) => {
      if (!inFlight()) return
      if (pipelined && error instanceof ApiError && error.status < 500 && error.code !== 'not_active') {
        // A pipelined move was built on a prediction the server did not accept
        // (the earlier move was blocked, or the requests were reordered). The
        // confirmed position is already authoritative; drop the rest of the
        // pipeline and let held input continue from it. No snapshot is needed.
        if (error.code !== 'stale_position' && stateRef.current === 'connected') setMessage(error.message)
        cancelMove()
        return
      }
      if (stateRef.current === 'connected') setMessage(error.message)
      // Transport failures and stale state have ambiguous outcomes. Never replay
      // the move: recover a snapshot before accepting new input.
      if (!(error instanceof ApiError) || error.status >= 500 || error.code === 'position-command-failed' || error.code === 'stale_position' || error.code === 'not_active') {
        cancelMove()
        synchronizerRef.current?.forceResync()
      }
    }).finally(() => {
      release()
      if (inFlight()) { clearTimeout(timer); settleMove(pending.id) }
    })
  }, [applyEvent, cancelMove, dead, fetchImpl, player, predict, settleMove, token, worldId])

  // Shots are ordered behind the moves already in flight when Fire is pressed,
  // so the laser leaves from the cell the player sees, in the direction they
  // last chose. The laser then recharges for LASER_COOLDOWN_MS from the moment it
  // is sent (the server enforces the same cadence); presses while a shot is
  // pending or recharging are ignored rather than fired late.
  const shotRef = useRef<{ pending: boolean; readyAt: number }>({ pending: false, readyAt: 0 })
  const rechargeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [recharging, setRecharging] = useState(false)
  const recharge = useCallback((ms: number) => {
    shotRef.current.readyAt = Math.max(shotRef.current.readyAt, Date.now() + ms)
    if (rechargeTimerRef.current) clearTimeout(rechargeTimerRef.current)
    setRecharging(true)
    rechargeTimerRef.current = setTimeout(() => {
      rechargeTimerRef.current = null
      setRecharging(false)
    }, Math.max(0, shotRef.current.readyAt - Date.now()))
  }, [])
  useEffect(() => () => {
    shotRef.current = { pending: false, readyAt: 0 }
    if (rechargeTimerRef.current) clearTimeout(rechargeTimerRef.current)
    rechargeTimerRef.current = null
    setRecharging(false)
  }, [dead, player?.id, token, worldId])
  const fire = useCallback((facing?: MoveDirection) => {
    if (!player || !token || dead || stateRef.current !== 'connected' || !playersRef.current[player.id]) return
    const shot = shotRef.current
    if (shot.pending || Date.now() < shot.readyAt) return
    shot.pending = true
    setMessage(null)
    const current = () => shotRef.current === shot && stateRef.current === 'connected'
    void Promise.all(pendingMovesRef.current.map((move) => move.settled)).then(() => {
      const confirmed = playersRef.current[player.id]
      if (!current() || !confirmed) return
      const payload = { expectedRevision: confirmed.positionRevision, ...(facing ? { facing } : {}) }
      recharge(LASER_COOLDOWN_MS)
      // The newest stream is read at send time: a reconnect while queued must not reuse a closed socket.
      const live = synchronizerRef.current?.commandsAvailable ? synchronizerRef.current : null
      return (live ? live.sendCommand('player.shoot', payload, commandId()) : submitWorldCommand(fetchImpl, worldId, token, 'player.shoot', payload))
        .then(({ event }) => { if (current()) applyEvent(event) })
        .catch((error: Error) => {
          if (!current()) return
          // A server-side recharge only means this press came early; it is not an error to show.
          if (error instanceof ApiError && error.code === 'shot_cooldown') return
          setMessage(error.message)
        })
    }).finally(() => { shot.pending = false })
  }, [applyEvent, dead, fetchImpl, player, recharge, token, worldId])

  const avatarSavingRef = useRef(false)
  const changeAvatar = useCallback(async (avatar: AvatarId): Promise<AvatarUpdate> => {
    if (!player || !token || stateRef.current !== 'connected' || avatarSavingRef.current) {
      throw new ApiError(409, 'avatar-unavailable', 'Avatar changes are unavailable right now. Try again shortly.')
    }
    avatarSavingRef.current = true
    try {
      const { event } = await submitWorldCommand(fetchImpl, worldId, token, 'player.avatar', {
        avatar, expectedRevision: playersRef.current[player.id]?.positionRevision,
      })
      if (!isAvatarUpdate(event.payload) || event.payload.playerId !== player.id) throw new ApiError(502, 'bad-response', 'The server returned an invalid avatar update.')
      if (stateRef.current === 'connected') applyEvent(event)
      setAvatarConflict(false)
      return event.payload
    } finally {
      avatarSavingRef.current = false
    }
  }, [applyEvent, fetchImpl, player, token, worldId])

  /**
   * Resolves an avatar conflict: an active life changes avatar in place; otherwise the
   * player spawns with the chosen avatar, which the server claims atomically.
   * A defeated player choosing here is rejoining, so the spawn carries their death revision.
   */
  const chooseConflictAvatar = useCallback(async (avatar: AvatarId): Promise<AvatarUpdate> => {
    if (!player || !token) throw new ApiError(409, 'avatar-unavailable', 'Sign in again before choosing an avatar.')
    if (playersRef.current[player.id]) return changeAvatar(avatar)
    if (stateRef.current !== 'connected' || placingRef.current) {
      throw new ApiError(409, 'avatar-unavailable', 'Avatar changes are unavailable right now. Try again shortly.')
    }
    placingRef.current = true
    const expectedDeathRevision = rejoinRevisionRef.current ?? deathRevisionRef.current
    try {
      const { event } = await submitWorldCommand(fetchImpl, worldId, token, 'player.place', {
        suggestedPosition: loadPlayerPosition(player.id, storage), expectedDeathRevision, avatar,
      })
      if (!isSharedPlayer(event.payload)) throw new ApiError(502, 'bad-response', 'The server returned an invalid placement.')
      rejoinRevisionRef.current = expectedDeathRevision
      if (stateRef.current === 'connected') applyEvent(event)
      placementRejectedRef.current = false
      setAvatarConflict(false)
      return event.payload
    } finally {
      placingRef.current = false
    }
  }, [applyEvent, changeAvatar, fetchImpl, player, storage, token, worldId])

  /** Cosmetic and live-only: never touches movement, prediction, or gameplay state. */
  const taunt = useCallback(() => {
    if (!player || !token || dead || stateRef.current !== 'connected' || !playersRef.current[player.id]) return
    synchronizerRef.current?.sendTaunt()
  }, [dead, player, token])

  const rejoin = useCallback(() => {
    rejoinRevisionRef.current = deathRevisionRef.current
    placementRejectedRef.current = false
    setDead(false)
  }, [])

  const retryPlacement = useCallback(() => {
    placementRejectedRef.current = false
    setPlacementAttempt((attempt) => attempt + 1)
  }, [])

  const own = player ? players[player.id] : undefined
  return { retryPlacement, ...status, players: sharedPlayers, position: own ?? null, predictedPosition, message, move, fire, taunt, taunts, shot, dead, attackerName, rejoin, spawnReveals,
    laserRecharging: recharging, mobs: sharedMobs, mobProjectiles, mobHitIds, mobAttackIds, mobDefeats, changeAvatar, avatarConflict, chooseConflictAvatar }
}
