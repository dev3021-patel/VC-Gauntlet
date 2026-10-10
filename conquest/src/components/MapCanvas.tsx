import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createTerrainCanvas, drawMap, GRASS_SPECK_COLOR, mapPixelRatio, WORLD } from '../mapRenderer'
import { Avatar } from './Avatar'
import { AvatarChangeModal } from './AvatarChangeModal'
import { HowToPlayPanel } from './HowToPlayPanel'
import { advanceMotion, displayedPoint, estimateStepDuration, isMotionSettled, type MarkerMotion } from '../markerMotion'
import { addGrassRustles, GRASS_RUSTLE_MS, grassPatchOnGrass, grassRustleFor, type GrassRustle } from '../grassRustle'
import { VirtualControls } from './VirtualControls'
import { directionForKey, isTraversable, type MoveDirection, type PlayerPosition } from '../playerPosition'
import { LASER_FLASH_MS, MOB_BODY_SIZE, laserStop, laserStrike, type LaserBody } from '../laser'
import { MAX_MOVES_IN_FLIGHT, MOVE_REPEAT_MS, SPRINT_REPEAT_MS } from '../movementCadence'
import { MOVEMENT_BLOCK_SIZE, movementBlockCenter, MOVEMENT_WORLD } from '../terrain'
import { uploadCustomAvatar } from '../session/api'
import { browserStorage, type StorageLike } from '../session/storage'
import type { AvatarId, AvatarUpload, Player } from '../session/types'
import { useAvatarAvailability } from '../useAvatarAvailability'
import { useFullscreen } from '../useFullscreen'
import { HOW_TO_PLAY_HIGHLIGHT_MS, hasSeenHowToPlay, markHowToPlaySeen } from '../howToPlay'
import { useInputMode } from '../useInputMode'
import { usePlayerPosition } from '../usePlayerPosition'
import { useWorldSync } from '../useWorldSync'
import { DEFAULT_WORLD_ID } from '../worldSync'
import {
  DEFAULT_LIMITS,
  constrainCamera,
  fitWorld,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Camera,
  type Point,
  type Size,
} from '../viewport'

const TAP_DRAG_THRESHOLD = 7
const ZOOM_STEP = 1.35

const SPAWN_SMOKE_PUFF_COUNT = 9
// Short, bounded prediction keeps rockets current rather than one tick behind.
const PROJECTILE_TICK_MS = 50
const PROJECTILE_CELLS_PER_TICK = 2.5
const DIRECTION_OFFSETS: Record<MoveDirection, { x: number; y: number }> = {
  north: { x: 0, y: -1 }, south: { x: 0, y: 1 }, west: { x: -1, y: 0 }, east: { x: 1, y: 0 },
}
const GRASS_RUSTLE_BLADE_COUNT = 3

/** A cell-sized laser overlay: beam, terrain stop, impact, or the local aim guide. */
/** `size` is in cells (default one): a mob impact ring covers that mob's whole body. */
type LaserCell = { key: string; cell: PlayerPosition; className: string; size?: number }

/** Fire uses the newest movement heading, otherwise the committed facing. */
function laserAim(position: PlayerPosition | null, aim: MoveDirection | null): MoveDirection | undefined {
  if (!position) return undefined
  if (aim) return aim
  return 'facing' in position ? position.facing as MoveDirection : undefined
}

function laserAxis(direction: MoveDirection) {
  return direction === 'east' || direction === 'west' ? 'horizontal' : 'vertical'
}

function movementKey(key: string) {
  return key.length === 1 ? key.toLowerCase() : key
}

type PointerSnapshot = {
  current: Point
  previous: Point
  origin: Point
}

type PinchSnapshot = {
  distance: number
  camera: Camera
  anchorWorld: Point
}

function pointerDistance([first, second]: PointerSnapshot[]) {
  return Math.hypot(second.current.x - first.current.x, second.current.y - first.current.y)
}

function pointerMidpoint([first, second]: PointerSnapshot[]): Point {
  return {
    x: (first.current.x + second.current.x) / 2,
    y: (first.current.y + second.current.y) / 2,
  }
}

function fitPadding(viewportWidth: number): number {
  return Math.min(54, Math.max(22, viewportWidth * 0.05))
}

function canvasPoint(event: PointerEvent | WheelEvent, canvas: HTMLCanvasElement): Point {
  const bounds = canvas.getBoundingClientRect()
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

function isEditingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (
    target.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(target.tagName)
    // jsdom does not implement inherited isContentEditable; closest also
    // makes descendants of editable regions explicit in tests.
    || target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  )
}

/** A fresh, unmodified press outside editable controls. `allowShift` lets an action work while sprinting. */
function isPlainKeyPress(event: KeyboardEvent, allowShift = false) {
  return !event.repeat
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && (allowShift || !event.shiftKey)
    && !isEditingTarget(event.target)
}

function ControlIcon({ children }: { children: string }) {
  return <span aria-hidden="true">{children}</span>
}

function syncLabel(state: ReturnType<typeof useWorldSync>) {
  if (state.state === 'connected') return `Synced · r${state.revision}`
  if (state.state === 'reconnecting') return 'Reconnecting…'
  if (state.state === 'unavailable') return 'Sync unavailable'
  return 'Syncing…'
}

function connectionCopy(state: ReturnType<typeof useWorldSync>['state']) {
  if (state === 'reconnecting') return ['Reconnecting to the shared world', 'Restoring the latest authoritative positions…']
  if (state === 'unavailable') return ['Shared world unavailable', 'We’ll keep trying automatically.']
  return ['Loading the shared world', 'Synchronizing authoritative positions…']
}

function ConnectionScreen({ state }: { state: ReturnType<typeof useWorldSync>['state'] }) {
  const [title, detail] = connectionCopy(state)
  return (
    <div className="connection-screen" role="status" aria-live="polite" aria-busy="true">
      <span className="connection-spinner" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  )
}

export type MapSyncDeps = {
  storage?: StorageLike | null
  fetchImpl?: typeof fetch
  createSocket?: Parameters<typeof useWorldSync>[1]['createSocket']
  minBackoffMs?: number
  maxBackoffMs?: number
}

export function MapCanvas({ player, token, syncDeps = {}, onPlayerChange }: {
  player: Player | null
  token: string | null
  syncDeps?: MapSyncDeps
  onPlayerChange?: (player: Player) => void
}) {
  const { storage, fetchImpl, createSocket, minBackoffMs, maxBackoffMs } = syncDeps
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<Size>({ width: 0, height: 0 })
  const cameraRef = useRef<Camera>({ centerX: WORLD.width / 2, centerY: WORLD.height / 2, zoom: 1 })
  const terrainRef = useRef<HTMLCanvasElement | null>(null)
  const animationRef = useRef<number | null>(null)
  // Inputs of the last static-map paint; entity-only frames reuse the canvas until one changes.
  const paintedMapRef = useRef<{ terrain: HTMLCanvasElement; camera: Camera; viewport: Size; pixelRatio: number } | null>(null)
  const pointersRef = useRef(new Map<number, PointerSnapshot>())
  const pinchRef = useRef<PinchSnapshot | null>(null)
  const mousePanningRef = useRef(false)
  const touchDraggedRef = useRef(false)
  const initializedRef = useRef(false)
  const playerRef = useRef(player)
  const positionRef = useRef<PlayerPosition | null>(null)
  const markerRef = useRef<HTMLDivElement>(null)
  const markerRefs = useRef(new Map<string, HTMLDivElement>())
  const laserRefs = useRef(new Map<string, HTMLSpanElement>())
  const laserCellsRef = useRef<LaserCell[]>([])
  const [aim, setAim] = useState<MoveDirection | null>(null)
  const aimRef = useRef(aim)
  aimRef.current = aim
  const spawnRevealRefs = useRef(new Map<string, HTMLDivElement>())
  const grassRustleRefs = useRef(new Map<string, HTMLDivElement>())
  const mobRefs = useRef(new Map<string, HTMLDivElement>())
  const mobDefeatRefs = useRef(new Map<string, HTMLSpanElement>())
  const projectileRefs = useRef(new Map<string, HTMLSpanElement>())
  // When each projectile position was first drawn, so the hop between server ticks is interpolated.
  const projectileSeenRef = useRef(new Map<string, { key: string; at: number }>())
  const focusedPlayerIdRef = useRef<string | null>(null)
  const heldMovementKeysRef = useRef(new Map<string, MoveDirection>())
  const movementTimerRef = useRef<number | null>(null)
  // When the last step was sent, so a cadence change retimes the next repeat instead of adding one.
  const lastStepAtRef = useRef(0)
  const sprintingRef = useRef(false)
  /** Repeat interval for the active held input: Shift sprints keyboard movement only. */
  const movementCadence = useCallback(() => {
    const activeKey = Array.from(heldMovementKeysRef.current.keys()).at(-1)
    return sprintingRef.current && activeKey !== undefined && !activeKey.startsWith('touch:') ? SPRINT_REPEAT_MS : MOVE_REPEAT_MS
  }, [])

  // Presentation-only interpolation keyed by player ID; gameplay reads authoritative refs only.
  const motionsRef = useRef(new Map<string, MarkerMotion>())
  // Grass rustles are derived from those motions; each one expires on its own recovery timer.
  const [grassRustles, setGrassRustles] = useState<GrassRustle[]>([])
  const grassRustlesRef = useRef(grassRustles)
  grassRustlesRef.current = grassRustles
  const grassRustleSeqRef = useRef(0)
  const grassRustleTimersRef = useRef(new Set<number>())
  const followPlayerRef = useRef(true)
  const [zoomLabel, setZoomLabel] = useState('100%')
  // Fit-world is a sticky user choice: while active, the camera never follows the player.
  const [fitWorldActive, setFitWorldActive] = useState(false)
  const fitWorldActiveRef = useRef(false)
  const [isPanning, setIsPanning] = useState(false)
  const [avatarModalOpen, setAvatarModalOpen] = useState(false)
  const avatarButtonRef = useRef<HTMLButtonElement>(null)
  const [cleanView, setCleanView] = useState(false)
  const cleanViewRef = useRef(cleanView)
  cleanViewRef.current = cleanView
  const preferenceStorage = storage === undefined ? browserStorage() : storage
  // First visit on this device opens the panel immediately, signed in or not.
  const [howToPlay, setHowToPlay] = useState<'first-visit' | 'reopened' | null>(() => hasSeenHowToPlay(preferenceStorage) ? null : 'first-visit')
  const howToPlayOpenRef = useRef(howToPlay !== null)
  howToPlayOpenRef.current = howToPlay !== null
  // The glow waits for the dock to be on screen: signed out, the sign-in form covers it.
  const [howToPlayHighlight, setHowToPlayHighlight] = useState<'pending' | 'on' | null>(null)
  const fullscreen = useFullscreen()
  const inputMode = useInputMode()
  const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion
  const sync = useWorldSync(DEFAULT_WORLD_ID, { player: token ? player : null, token, storage, fetchImpl, createSocket, minBackoffMs, maxBackoffMs })
  const blocked = sync.state !== 'connected'
  // A contested saved avatar forces the picker open until the player chooses another.
  const avatarPickerOpen = avatarModalOpen || (!!token && sync.avatarConflict)
  const avatarAvailability = useAvatarAvailability(DEFAULT_WORLD_ID, avatarPickerOpen, player?.id ?? null, fetchImpl)
  const inputBlocked = blocked || avatarPickerOpen || howToPlay !== null
  const connectedRef = useRef(sync.state === 'connected')
  connectedRef.current = !inputBlocked
  const sharedPlayersRef = useRef(sync.players)
  sharedPlayersRef.current = sync.players
  const playerId = player?.id ?? null
  const local = usePlayerPosition(token ? null : playerId, storage)
  const position = token ? sync.position : local.position
  // Presentation-only: the local marker glides toward the newest submitted move before the server confirms it.
  const predictedPosition = token ? sync.predictedPosition ?? null : null
  const currentAvatar = sync.position?.avatar ?? player?.avatar
  // Held input pipelines up to `maxMovesInFlight` moves so confirmation latency cannot cap the cadence.
  const move: (direction: MoveDirection, maxInFlight?: number) => void = token ? sync.move : local.move
  const moveRef = useRef(move)
  const fireRef = useRef(sync.fire)
  moveRef.current = move
  fireRef.current = () => sync.fire(laserAim(positionRef.current, aimRef.current))
  const tauntRef = useRef(sync.taunt)
  tauntRef.current = sync.taunt
  const rejoinRef = useRef(sync.rejoin)
  rejoinRef.current = sync.rejoin
  const rejoinReadyRef = useRef(false)
  rejoinReadyRef.current = sync.dead && !blocked
  playerRef.current = player
  positionRef.current = position

  const closeAvatarModal = useCallback(() => {
    setAvatarModalOpen(false)
    window.requestAnimationFrame(() => avatarButtonRef.current?.focus())
  }, [])

  const closeHowToPlay = useCallback((returnFocus: HTMLElement | null) => {
    if (howToPlay === 'first-visit') {
      markHowToPlaySeen(preferenceStorage)
      // Point out where the panel went so an accidental close is recoverable.
      setHowToPlayHighlight('pending')
    }
    setHowToPlay(null)
    window.requestAnimationFrame(() => {
      const target = returnFocus?.isConnected ? returnFocus : canvasRef.current
      target?.focus({ preventScroll: true })
    })
  }, [howToPlay, preferenceStorage])

  useEffect(() => {
    if (howToPlayHighlight === 'pending' && player) setHowToPlayHighlight('on')
    if (howToPlayHighlight !== 'on') return
    const timer = window.setTimeout(() => setHowToPlayHighlight(null), HOW_TO_PLAY_HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [howToPlayHighlight, player])

  const saveAvatar = useCallback(async (avatar: AvatarId) => {
    if (!player) return 'Sign in again before changing your avatar.'
    try {
      const updated = await (sync.avatarConflict ? sync.chooseConflictAvatar(avatar) : sync.changeAvatar(avatar))
      onPlayerChange?.({ ...player, avatar: updated.avatar })
      closeAvatarModal()
      return null
    } catch (error) {
      avatarAvailability.refresh()
      return error instanceof Error ? error.message : 'Avatar could not be changed. Try again.'
    }
  }, [avatarAvailability.refresh, closeAvatarModal, onPlayerChange, player, sync.avatarConflict, sync.chooseConflictAvatar, sync.changeAvatar])

  /** Stores a replacement upload; the stored account follows, and the modal selects the new image. */
  const uploadAvatar = useCallback(async (upload: AvatarUpload) => {
    if (!player || !token) throw new Error('Sign in again before uploading an image.')
    const updated = await uploadCustomAvatar(token, upload, fetchImpl)
    onPlayerChange?.({ ...player, avatar: updated.avatar, customAvatar: updated.customAvatar })
    return updated.customAvatar!
  }, [fetchImpl, onPlayerChange, player, token])

  const spawnRevealsRef = useRef(sync.spawnReveals)
  const mobsRef = useRef(sync.mobs)
  const mobDefeatsRef = useRef(sync.mobDefeats)
  spawnRevealsRef.current = sync.spawnReveals
  mobsRef.current = sync.mobs
  mobDefeatsRef.current = sync.mobDefeats
  const projectilesRef = useRef(sync.mobProjectiles)
  projectilesRef.current = sync.mobProjectiles

  /** Positions a patch for the current camera, hidden whenever terrain under it is not the same grass. */
  const placeGrassRustle = useCallback((patch: HTMLDivElement, rustle: GrassRustle) => {
    const screen = worldToScreen(movementBlockCenter(rustle.x, rustle.y), cameraRef.current, viewportRef.current)
    patch.style.visibility = grassPatchOnGrass(rustle, cameraRef.current.zoom) ? '' : 'hidden'
    patch.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)`
  }, [])

  const requestDraw = useCallback(() => {
    if (animationRef.current !== null) return
    animationRef.current = window.requestAnimationFrame(() => {
      animationRef.current = null
      const canvas = canvasRef.current
      if (!canvas || !terrainRef.current) return
      const position = positionRef.current
      const currentPlayer = playerRef.current
      const now = performance.now()
      let animating = false
      const localMotion = currentPlayer && position ? motionsRef.current.get(currentPlayer.id) : undefined
      if (localMotion && followPlayerRef.current) {
        const center = displayedPoint(localMotion, now)
        cameraRef.current = constrainCamera({ ...cameraRef.current, centerX: center.x, centerY: center.y }, WORLD, viewportRef.current)
      }
      const painted = paintedMapRef.current
      const camera = cameraRef.current
      const viewport = viewportRef.current
      const pixelRatio = mapPixelRatio()
      if (!painted || painted.terrain !== terrainRef.current || painted.pixelRatio !== pixelRatio
        || painted.camera.centerX !== camera.centerX || painted.camera.centerY !== camera.centerY || painted.camera.zoom !== camera.zoom
        || painted.viewport.width !== viewport.width || painted.viewport.height !== viewport.height) {
        paintedMapRef.current = drawMap(canvas, terrainRef.current, camera, viewport)
          ? { terrain: terrainRef.current, camera, viewport, pixelRatio }
          : null
      }
      const marker = markerRef.current
      if (marker && position && currentPlayer) {
        const world = localMotion ? displayedPoint(localMotion, now) : movementBlockCenter(position.x, position.y)
        const screen = worldToScreen(world, cameraRef.current, viewportRef.current)
        marker.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)`
        if (localMotion && !isMotionSettled(localMotion, now)) animating = true
      }
      for (const shared of sharedPlayersRef.current) {
        const sharedMarker = markerRefs.current.get(shared.playerId)
        if (!sharedMarker || shared.playerId === currentPlayer?.id) continue
        const motion = motionsRef.current.get(shared.playerId)
        const world = motion ? displayedPoint(motion, now) : movementBlockCenter(shared.x, shared.y)
        const screen = worldToScreen(world, cameraRef.current, viewportRef.current)
        sharedMarker.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)`
        if (motion && !isMotionSettled(motion, now)) animating = true
      }
      const cellPixels = MOVEMENT_BLOCK_SIZE * cameraRef.current.zoom
      laserCellsRef.current.forEach(({ key, cell, size = 1 }) => {
        const node = laserRefs.current.get(key)
        if (!node) return
        const screen = worldToScreen(movementBlockCenter(cell.x, cell.y), cameraRef.current, viewportRef.current)
        node.style.width = `${cellPixels * size}px`
        node.style.height = `${cellPixels * size}px`
        node.style.left = `${screen.x}px`
        node.style.top = `${screen.y}px`
      })
      grassRustlesRef.current.forEach((rustle) => {
        const patch = grassRustleRefs.current.get(rustle.id)
        if (patch) placeGrassRustle(patch, rustle)
      })
      spawnRevealsRef.current.forEach((reveal) => {
        const cloud = spawnRevealRefs.current.get(reveal.id)
        if (!cloud) return
        const screen = worldToScreen(movementBlockCenter(reveal.x, reveal.y), cameraRef.current, viewportRef.current)
        cloud.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)`
      })
      // Enemy bodies are drawn at their world-space hitbox (`MOB_BODY_SIZE` cells) at every zoom.
      mobsRef.current.forEach((mob) => {
        const marker = mobRefs.current.get(mob.mobId)
        if (!marker) return
        const screen = worldToScreen(movementBlockCenter(mob.x, mob.y), cameraRef.current, viewportRef.current)
        marker.style.setProperty('--mob-body-size', `${cellPixels * MOB_BODY_SIZE}px`)
        marker.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)`
      })
      const seen = projectileSeenRef.current
      for (const id of seen.keys()) if (!projectilesRef.current.some((projectile) => projectile.id === id)) seen.delete(id)
      projectilesRef.current.forEach((projectile) => {
        const node = projectileRefs.current.get(projectile.id)
        if (!node) return
        const key = `${projectile.x},${projectile.y},${projectile.distance}`
        let entry = seen.get(projectile.id)
        if (entry?.key !== key) { entry = { key, at: now }; seen.set(projectile.id, entry) }
        const cardinal = DIRECTION_OFFSETS[projectile.facing]
        const offset = { x: projectile.dx ?? cardinal.x, y: projectile.dy ?? cardinal.y }
        const progress = reducedMotionRef.current ? 0 : Math.min(1, (now - entry.at) / PROJECTILE_TICK_MS)
        if (progress < 1) animating = true
        // Never predict through terrain; the server owns player hits/removal.
        let travel = 0
        for (let next = 0.1; next <= progress * PROJECTILE_CELLS_PER_TICK; next += 0.1) {
          const x = projectile.x + offset.x * next
          const y = projectile.y + offset.y * next
          if (![-0.15, 0.15].every((ox) => [-0.15, 0.15].every((oy) =>
            isTraversable({ x: Math.floor(x + ox + 0.5), y: Math.floor(y + oy + 0.5) })))) break
          travel = next
        }
        const point = movementBlockCenter(projectile.x + offset.x * travel, projectile.y + offset.y * travel)
        const screen = worldToScreen(point, cameraRef.current, viewportRef.current)
        const angle = Math.atan2(offset.y, offset.x) * 180 / Math.PI
        node.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%) rotate(${angle}deg)`
      })
      mobDefeatsRef.current.forEach((defeat) => {
        const burst = mobDefeatRefs.current.get(defeat.id)
        if (!burst) return
        const screen = worldToScreen(movementBlockCenter(defeat.x, defeat.y), cameraRef.current, viewportRef.current)
        burst.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)`
      })
      if (animating) requestDraw()
    })
  }, [placeGrassRustle])

  const setFitWorld = useCallback((active: boolean) => {
    fitWorldActiveRef.current = active
    setFitWorldActive(active)
  }, [])

  const commitCamera = useCallback(
    (camera: Camera) => {
      cameraRef.current = constrainCamera(camera, WORLD, viewportRef.current)
      setZoomLabel(`${Math.round(cameraRef.current.zoom * 100)}%`)
      requestDraw()
    },
    [requestDraw],
  )

  // Any explicit camera change other than fitting the world (pan, zoom, "My player") leaves fit-world mode,
  // so the button state always matches what is on screen.
  const applyCamera = useCallback(
    (camera: Camera) => {
      setFitWorld(false)
      commitCamera(camera)
    },
    [commitCamera, setFitWorld],
  )

  const fit = useCallback(() => {
    commitCamera(fitWorld(WORLD, viewportRef.current, fitPadding(viewportRef.current.width)))
  }, [commitCamera])

  const focusPlayer = useCallback((target: PlayerPosition) => {
    followPlayerRef.current = true
    const center = movementBlockCenter(target.x, target.y)
    applyCamera({ centerX: center.x, centerY: center.y, zoom: Math.max(4, cameraRef.current.zoom) })
  }, [applyCamera])

  const toggleFitWorld = useCallback(() => {
    if (fitWorldActiveRef.current) {
      if (positionRef.current) focusPlayer(positionRef.current)
      else setFitWorld(false)
      return
    }
    followPlayerRef.current = false
    setFitWorld(true)
    fit()
  }, [fit, focusPlayer, setFitWorld])

  // Reconcile marker motion with newly accepted authoritative positions, then draw.
  // Any discontinuity in identity, life state, or connection snaps every marker first.
  const motionEpoch = `${playerId ?? ''}|${sync.dead}|${sync.state}`
  const motionEpochRef = useRef(motionEpoch)
  useEffect(() => {
    const now = performance.now()
    const motions = motionsRef.current
    if (motionEpochRef.current !== motionEpoch) {
      motionEpochRef.current = motionEpoch
      motions.clear()
    }
    const live = new Set<string>()
    const rustles: GrassRustle[] = []
    const reconcile = (id: string, previous: MarkerMotion | null, next: MarkerMotion) => {
      live.add(id)
      motions.set(id, next)
      const rustle = grassRustleFor(previous, next, `${id}:${grassRustleSeqRef.current}`)
      if (rustle) {
        grassRustleSeqRef.current += 1
        rustles.push(rustle)
      }
    }
    if (playerId && position) {
      const previous = motions.get(playerId) ?? null
      reconcile(playerId, previous, advanceMotion(previous, predictedPosition ?? position, now, movementCadence(), reducedMotionRef.current))
    }
    for (const shared of sync.players) {
      if (shared.playerId === playerId) continue
      const previous = motions.get(shared.playerId) ?? null
      reconcile(shared.playerId, previous, advanceMotion(previous, shared, now, estimateStepDuration(previous, now, MOVE_REPEAT_MS), reducedMotionRef.current))
    }
    for (const id of motions.keys()) if (!live.has(id)) motions.delete(id)
    if (rustles.length) {
      setGrassRustles((current) => addGrassRustles(current, rustles))
      const timer = window.setTimeout(() => {
        grassRustleTimersRef.current.delete(timer)
        setGrassRustles((current) => current.filter((rustle) => !rustles.includes(rustle)))
      }, GRASS_RUSTLE_MS)
      grassRustleTimersRef.current.add(timer)
    }
    requestDraw()
  }, [motionEpoch, movementCadence, playerId, position, predictedPosition, requestDraw, sync.players])

  useEffect(() => {
    if (!position || !playerId) {
      requestDraw()
      return
    }
    followPlayerRef.current = !fitWorldActiveRef.current
    requestDraw()
    if (focusedPlayerIdRef.current !== playerId) {
      focusedPlayerIdRef.current = playerId
      // Closing How to play focuses the canvas itself; never pull focus out of the open panel.
      if (!howToPlayOpenRef.current) canvasRef.current?.focus({ preventScroll: true })
    }
  }, [playerId, position, requestDraw])

  useEffect(() => {
    const timers = grassRustleTimersRef.current
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
    }
  }, [])

  useEffect(() => requestDraw(), [grassRustles, requestDraw, sync.mobDefeats, sync.mobProjectiles, sync.mobs, sync.players, sync.shot, sync.spawnReveals])

  const zoomFromCenter = useCallback(
    (factor: number) => {
      const viewport = viewportRef.current
      const anchor = { x: viewport.width / 2, y: viewport.height / 2 }
      applyCamera(zoomAt(cameraRef.current, cameraRef.current.zoom * factor, anchor, viewport))
    },
    [applyCamera],
  )

  useEffect(() => {
    if (!inputBlocked) return
    const canvas = canvasRef.current
    if (canvas) {
      for (const pointerId of pointersRef.current.keys()) {
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
      }
    }
    pointersRef.current.clear()
    pinchRef.current = null
    mousePanningRef.current = false
    touchDraggedRef.current = false
    setIsPanning(false)
  }, [inputBlocked])

  // Held movement is shared by the keyboard handlers and the touch control
  // pad: both feed the same key map and repeat timer so cadence and
  // blocked-move rules stay identical regardless of input device.
  const clearHeldMovement = useCallback(() => {
    heldMovementKeysRef.current.clear()
    sprintingRef.current = false
    if (movementTimerRef.current !== null) {
      window.clearTimeout(movementTimerRef.current)
      movementTimerRef.current = null
    }
  }, [])

  const steer = useCallback((direction: MoveDirection) => {
    // Aim follows input immediately, even when the step is blocked or still confirming.
    lastStepAtRef.current = performance.now()
    aimRef.current = direction
    setAim(direction)
    moveRef.current(direction, MAX_MOVES_IN_FLIGHT)
  }, [])

  /** Schedules the next repeat. `retime` keeps the last step's timing and only applies a new cadence. */
  const scheduleMovement = useCallback((retime = false) => {
    if (movementTimerRef.current !== null) window.clearTimeout(movementTimerRef.current)
    const delay = retime ? Math.max(0, lastStepAtRef.current + movementCadence() - performance.now()) : movementCadence()
    movementTimerRef.current = window.setTimeout(function repeatMovement() {
      movementTimerRef.current = null
      const direction = Array.from(heldMovementKeysRef.current.values()).at(-1)
      if (!direction || !connectedRef.current || !playerRef.current || !positionRef.current) {
        clearHeldMovement()
        return
      }
      steer(direction)
      movementTimerRef.current = window.setTimeout(repeatMovement, movementCadence())
    }, delay)
  }, [clearHeldMovement, movementCadence, steer])

  const setSprinting = useCallback((sprinting: boolean) => {
    if (sprintingRef.current === sprinting) return
    sprintingRef.current = sprinting
    if (movementTimerRef.current !== null) scheduleMovement(true)
  }, [scheduleMovement])

  /** Starts (or continues) held movement for an input key. Returns false when gameplay input is unavailable. */
  const pressMovement = useCallback((key: string, direction: MoveDirection) => {
    if (!connectedRef.current || !playerRef.current || !positionRef.current) return false
    if (heldMovementKeysRef.current.has(key)) return true
    const previousDirection = Array.from(heldMovementKeysRef.current.values()).at(-1)
    heldMovementKeysRef.current.set(key, direction)
    if (previousDirection !== direction) steer(direction)
    scheduleMovement()
    return true
  }, [scheduleMovement, steer])

  const releaseMovement = useCallback((key: string) => {
    heldMovementKeysRef.current.delete(key)
    if (heldMovementKeysRef.current.size === 0) clearHeldMovement()
    else scheduleMovement()
  }, [clearHeldMovement, scheduleMovement])

  const startTouchMovement = useCallback((direction: MoveDirection) => { pressMovement(`touch:${direction}`, direction) }, [pressMovement])
  const stopTouchMovement = useCallback((direction: MoveDirection) => {
    if (heldMovementKeysRef.current.has(`touch:${direction}`)) releaseMovement(`touch:${direction}`)
  }, [releaseMovement])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // How to play owns the keyboard while open; it handles Escape and Tab itself.
      if (howToPlayOpenRef.current) return
      const direction = directionForKey(event.key)
      const isEditing = isEditingTarget(event.target)
      if (event.key === 'Escape' && cleanViewRef.current && !document.fullscreenElement && !isEditing) {
        setCleanView(false)
        return
      }
      if (event.key === 'Shift') {
        if (!isEditing) setSprinting(true)
        return
      }
      const plainMovement = connectedRef.current && playerRef.current && positionRef.current && !event.altKey && !event.ctrlKey && !event.metaKey && !isEditing
      if (plainMovement && direction) {
        event.preventDefault()
        if (event.repeat) return
        // Shift may already be down (pressed before focus, or first): sprint follows the modifier.
        setSprinting(event.shiftKey)
        pressMovement(movementKey(event.key), direction)
        return
      }
      if (direction && isEditing) {
        clearHeldMovement()
        return
      }
      // While defeated, Space rejoins instead of firing. The ready ref is
      // cleared immediately so presses before the re-render cannot rejoin twice.
      if (event.code === 'Space' && sync.dead && isPlainKeyPress(event)) {
        event.preventDefault()
        if (!rejoinReadyRef.current) return
        rejoinReadyRef.current = false
        rejoinRef.current()
        return
      }
      if (connectedRef.current && event.key.toLowerCase() === 'r' && isPlainKeyPress(event, true)) {
        event.preventDefault()
        tauntRef.current()
        return
      }
      if (!connectedRef.current || event.code !== 'Space' || !isPlainKeyPress(event, true)) return
      event.preventDefault()
      fireRef.current()
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setSprinting(false)
        return
      }
      if (!directionForKey(event.key)) return
      releaseMovement(movementKey(event.key))
    }
    const handleVisibilityChange = () => { if (document.hidden) clearHeldMovement() }
    const handleFocusIn = (event: FocusEvent) => { if (isEditingTarget(event.target)) clearHeldMovement() }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', clearHeldMovement)
    window.addEventListener('focusin', handleFocusIn)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', clearHeldMovement)
      window.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      clearHeldMovement()
    }
  }, [clearHeldMovement, inputBlocked, playerId, pressMovement, releaseMovement, setSprinting, sync.dead])

  useEffect(() => {
    terrainRef.current = createTerrainCanvas()
    const canvas = canvasRef.current
    if (!canvas) return

    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      const height = entry.contentRect.height
      if (width <= 0 || height <= 0) return

      viewportRef.current = { width, height }
      if (!initializedRef.current) {
        initializedRef.current = true
        cameraRef.current = fitWorld(WORLD, viewportRef.current, fitPadding(width))
        if (positionRef.current) {
          const center = movementBlockCenter(positionRef.current.x, positionRef.current.y)
          cameraRef.current = { ...cameraRef.current, centerX: center.x, centerY: center.y }
        }
        setZoomLabel(`${Math.round(cameraRef.current.zoom * 100)}%`)
      } else if (fitWorldActiveRef.current) {
        cameraRef.current = fitWorld(WORLD, viewportRef.current, fitPadding(width))
        setZoomLabel(`${Math.round(cameraRef.current.zoom * 100)}%`)
      } else {
        cameraRef.current = constrainCamera(cameraRef.current, WORLD, viewportRef.current)
      }
      requestDraw()
    })
    resizeObserver.observe(canvas)
    // A density change (another monitor, browser zoom) need not resize the canvas, so watch it directly.
    let pixelRatioQuery: MediaQueryList | null = null
    function watchPixelRatio() {
      pixelRatioQuery?.removeEventListener?.('change', handlePixelRatioChange)
      pixelRatioQuery = typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
        : null
      pixelRatioQuery?.addEventListener?.('change', handlePixelRatioChange)
    }
    function handlePixelRatioChange() {
      watchPixelRatio()
      requestDraw()
    }
    watchPixelRatio()
    return () => {
      resizeObserver.disconnect()
      pixelRatioQuery?.removeEventListener?.('change', handlePixelRatioChange)
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
    }
  }, [requestDraw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleWheel = (event: WheelEvent) => {
      if (!connectedRef.current) return
      event.preventDefault()
      followPlayerRef.current = false
      const viewport = viewportRef.current
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.0025)
        applyCamera(
          zoomAt(cameraRef.current, cameraRef.current.zoom * factor, canvasPoint(event, canvas), viewport),
        )
        return
      }

      const horizontal = event.shiftKey ? event.deltaY + event.deltaX : event.deltaX
      const vertical = event.shiftKey ? 0 : event.deltaY
      applyCamera(panBy(cameraRef.current, { x: -horizontal, y: -vertical }))
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!connectedRef.current) return
      const point = canvasPoint(event, canvas)
      if (event.pointerType === 'touch') {
        event.preventDefault()
        canvas.setPointerCapture(event.pointerId)
        pointersRef.current.set(event.pointerId, { current: point, previous: point, origin: point })
        touchDraggedRef.current = false

        if (pointersRef.current.size === 2) {
          const pointers = Array.from(pointersRef.current.values())
          const midpoint = pointerMidpoint(pointers)
          pinchRef.current = {
            camera: cameraRef.current,
            distance: Math.max(1, pointerDistance(pointers)),
            anchorWorld: screenToWorld(midpoint, cameraRef.current, viewportRef.current),
          }
        }
        setIsPanning(true)
        return
      }

      const canPan = event.button === 1
      if (!canPan) return
      event.preventDefault()
      canvas.setPointerCapture(event.pointerId)
      pointersRef.current.set(event.pointerId, { current: point, previous: point, origin: point })
      mousePanningRef.current = true
      setIsPanning(true)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!connectedRef.current) return
      const stored = pointersRef.current.get(event.pointerId)
      if (!stored) return
      event.preventDefault()
      followPlayerRef.current = false
      const point = canvasPoint(event, canvas)
      stored.previous = stored.current
      stored.current = point

      if (event.pointerType !== 'touch') {
        applyCamera(
          panBy(cameraRef.current, {
            x: point.x - stored.previous.x,
            y: point.y - stored.previous.y,
          }),
        )
        return
      }

      const pointers = Array.from(pointersRef.current.values())
      if (pointers.length >= 2 && pinchRef.current) {
        const midpoint = pointerMidpoint(pointers)
        const distance = Math.max(1, pointerDistance(pointers))
        const zoom = Math.min(
          DEFAULT_LIMITS.maxZoom,
          Math.max(DEFAULT_LIMITS.minZoom, pinchRef.current.camera.zoom * (distance / pinchRef.current.distance)),
        )
        applyCamera({
          centerX: pinchRef.current.anchorWorld.x - (midpoint.x - viewportRef.current.width / 2) / zoom,
          centerY: pinchRef.current.anchorWorld.y - (midpoint.y - viewportRef.current.height / 2) / zoom,
          zoom,
        })
        touchDraggedRef.current = true
      } else if (pointers.length === 1) {
        const movement = Math.hypot(point.x - stored.origin.x, point.y - stored.origin.y)
        if (movement >= TAP_DRAG_THRESHOLD) touchDraggedRef.current = true
        applyCamera(
          panBy(cameraRef.current, {
            x: point.x - stored.previous.x,
            y: point.y - stored.previous.y,
          }),
        )
      }
    }

    const finishPointer = (event: PointerEvent) => {
      const hadPointer = pointersRef.current.delete(event.pointerId)
      if (!hadPointer) return
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)

      if (event.pointerType === 'touch' && pointersRef.current.size === 1) {
        const remaining = Array.from(pointersRef.current.values())[0]
        remaining.previous = remaining.current
        remaining.origin = remaining.current
        pinchRef.current = null
      } else if (pointersRef.current.size === 0) {
        pinchRef.current = null
        mousePanningRef.current = false
        setIsPanning(false)
      }
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', finishPointer)
    canvas.addEventListener('pointercancel', finishPointer)

    return () => {
      canvas.removeEventListener('wheel', handleWheel)
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerup', finishPointer)
      canvas.removeEventListener('pointercancel', finishPointer)
    }
  }, [applyCamera])

  // The aim guide is local-only and mirrors the server's lane: the newest heading, terrain-shortened.
  const aimDirection = token && player && position && !blocked && !sync.dead ? laserAim(position, aim) : undefined
  const aimOrigin = predictedPosition ?? position
  // Units the client can see end the guide where their bodies meet the beam, as they will end the shot.
  const aimBodies: LaserBody[] = [
    ...sync.players.filter((shared) => shared.playerId !== playerId).map(({ x, y }) => ({ x, y, kind: 'player' as const })),
    ...sync.mobs.map(({ x, y, kind }) => ({ x, y, kind: kind === 'ranged' ? 'ranged' as const : 'basic' as const })),
  ]
  const aimStrike = aimDirection && aimOrigin ? laserStrike(aimOrigin, aimDirection, aimBodies) : null
  const aimLane = aimStrike?.lane ?? []
  const aimTarget = !!aimStrike?.target
  const aimStop = aimDirection && aimOrigin && !aimTarget ? laserStop(aimOrigin, aimLane, aimDirection) : null
  const shot = sync.shot
  const shotStop = shot ? laserStop(shot.origin, shot.path, shot.facing) : null
  const shotVictims = shot ? shot.eliminatedVictims ?? shot.victims ?? (shot.victim ? [shot.victim] : []) : []
  const shotMobHits = shot?.mobHits ?? []
  const laserVariant = reducedMotion ? ' laser--reduced' : ''
  const laserCells: LaserCell[] = [
    ...(aimDirection ? [
      ...aimLane.map((cell, index) => ({ key: `aim-${index}`, cell, className: `laser-aim laser-aim--${laserAxis(aimDirection)}${sync.laserRecharging ? ' laser-aim--recharging' : ''}` })),
      ...(aimStop ? [{ key: 'aim-stop', cell: aimStop, className: `laser-aim-stop laser-aim-stop--${aimDirection}` }] : []),
    ] : []),
    ...(shot ? [
      ...shot.path.map((cell, index) => ({ key: `${shot.shotId}-${index}`, cell, className: `laser-beam laser-beam--${laserAxis(shot.facing)}${laserVariant}` })),
      ...(shotStop ? [{ key: `${shot.shotId}-stop`, cell: shotStop, className: `laser-stop laser-stop--${shot.facing}${laserVariant}` }] : []),
      ...shotVictims.map((victim) => ({ key: `${shot.shotId}-impact-${victim.playerId}`, cell: victim, className: `laser-impact${laserVariant}` })),
      ...shotMobHits.map((hit) => ({ key: `${shot.shotId}-impact-${hit.mobId}`, cell: hit, className: `laser-impact${laserVariant}`, size: MOB_BODY_SIZE })),
    ] : []),
  ]
  laserCellsRef.current = laserCells
  const laserSignature = laserCells.map(({ key, cell }) => `${key}@${cell.x},${cell.y}`).join('|')
  useEffect(() => requestDraw(), [laserSignature, requestDraw])
  useEffect(() => setAim(null), [playerId, sync.dead])

  return (
    <section className={`map-viewport${cleanView ? ' map-viewport--clean' : ''}${inputMode === 'touch' ? ' map-viewport--touch' : ''}`} aria-label="Party Conquest world map" data-clean-view={cleanView || undefined}>
      <canvas
        ref={canvasRef}
        tabIndex={avatarPickerOpen || howToPlay ? -1 : 0}
        className={isPanning ? 'is-panning' : undefined}
        aria-label={`Interactive ${MOVEMENT_WORLD.width} by ${MOVEMENT_WORLD.height} block world rendered at ${WORLD.width} by ${WORLD.height} terrain resolution. Use the map navigation controls or supported pan and zoom gestures.`}
        onContextMenu={(event) => event.preventDefault()}
      />
      {player && position && (
        <>
          <div
            ref={markerRef}
            className="player-marker"
            aria-hidden="true"
          >
            <span key={sync.taunts[player.id] ?? 0} className={`player-marker-visual${sync.taunts[player.id] ? ' player-marker-visual--taunting' : ''}`}>
              {currentAvatar && <Avatar id={currentAvatar} size="md" />}
              {'facing' in position && <span className={`facing-indicator facing-indicator--${position.facing as MoveDirection}`} data-facing={position.facing as MoveDirection} />}
            </span>
            <span className="player-marker-name">{player.name}</span>
          </div>
          <p className="player-location" aria-live="polite">
            {player.name} at column {position.x + 1}, row {position.y + 1}
          </p>
        </>
      )}
      {sync.players.filter((shared) => shared.playerId !== playerId).map((shared) => (
        <div
          key={shared.playerId}
          ref={(node) => { if (node) markerRefs.current.set(shared.playerId, node); else markerRefs.current.delete(shared.playerId) }}
          className="player-marker player-marker--remote"
          aria-label={`${shared.name}, at column ${shared.x + 1}, row ${shared.y + 1}`}
        >
          <span key={sync.taunts[shared.playerId] ?? 0} className={`player-marker-visual${sync.taunts[shared.playerId] ? ' player-marker-visual--taunting' : ''}`}>
            <Avatar id={shared.avatar} size="md" />
            <span className={`facing-indicator facing-indicator--${shared.facing}`} data-facing={shared.facing} aria-hidden="true" />
          </span>
          <span className="player-marker-name">{shared.name}</span>
        </div>
      ))}
      {grassRustles.map((rustle) => (
        <div
          key={rustle.id}
          ref={(node) => {
            if (!node) return void grassRustleRefs.current.delete(rustle.id)
            // Place on mount so a patch never shows unpositioned while waiting for the next frame.
            placeGrassRustle(node, rustle)
            grassRustleRefs.current.set(rustle.id, node)
          }}
          className={`grass-rustle grass-rustle--${rustle.direction}`}
          data-cell={`${rustle.x},${rustle.y}`}
          style={{ '--grass-color': rustle.color, '--grass-speck': GRASS_SPECK_COLOR } as CSSProperties}
          aria-hidden="true"
        >
          {['left', 'right'].map((side) => (
            <span key={side} className="grass-rustle-tuft">
              {Array.from({ length: GRASS_RUSTLE_BLADE_COUNT }, (_, index) => <span key={index} className={`grass-rustle-blade grass-rustle-blade--${index + 1}`} />)}
            </span>
          ))}
        </div>
      ))}
      {sync.spawnReveals.map((reveal) => (
        <div
          key={reveal.id}
          ref={(node) => { if (node) spawnRevealRefs.current.set(reveal.id, node); else spawnRevealRefs.current.delete(reveal.id) }}
          className="spawn-smoke"
          data-player-id={reveal.playerId}
          aria-hidden="true"
        >
          {Array.from({ length: SPAWN_SMOKE_PUFF_COUNT }, (_, index) => <span key={index} className={`spawn-smoke-puff spawn-smoke-puff--${index + 1}`} />)}
        </div>
      ))}
      {sync.mobs.map((mob) => (
        <div
          key={mob.mobId}
          ref={(node) => { if (node) mobRefs.current.set(mob.mobId, node); else mobRefs.current.delete(mob.mobId) }}
          className={`mob-marker mob-marker--${mob.kind === 'ranged' ? 'ranged' : 'melee'} mob-marker--${mob.facing}${mob.windingUp ? ' mob-marker--winding' : ''}${sync.mobHitIds[mob.mobId] ? ' mob-marker--hit' : ''}${sync.mobAttackIds[mob.mobId] ? ' mob-marker--attacking' : ''}${reducedMotion ? ' mob-marker--reduced' : ''}`}
          role="img"
          data-mob-id={mob.mobId}
          data-health={mob.health}
          data-kind={mob.kind}
          aria-label={`${mob.kind === 'ranged' ? 'Ranged enemy' : 'Enemy mob'}${mob.windingUp ? ' winding up a shot' : ''} with ${mob.health} of ${mob.maxHealth} health at column ${mob.x + 1}, row ${mob.y + 1}`}
        >
          <span className="mob-health-bar" aria-hidden="true" data-testid="mob-health-bar">
            <span className="mob-health-bar-fill" style={{ width: `${Math.round((Math.max(0, mob.health) / Math.max(1, mob.maxHealth)) * 100)}%` }} />
          </span>
          <span key={`${sync.mobHitIds[mob.mobId] ?? 0}-${sync.mobAttackIds[mob.mobId] ?? 0}`} className="mob-marker-body" aria-hidden="true">
            {mob.kind === 'ranged' ? <span className="mob-marker-eye" /> : <><span className="mob-marker-eye" /><span className="mob-marker-eye" /></>}
          </span>
        </div>
      ))}
      {sync.mobProjectiles.map((projectile) => (
        <span
          key={projectile.id}
          ref={(node) => { if (node) projectileRefs.current.set(projectile.id, node); else projectileRefs.current.delete(projectile.id) }}
          className="mob-projectile"
          aria-label="Enemy rocket"
          data-testid="mob-projectile"
          aria-hidden="true"
        />
      ))}
      {sync.mobDefeats.map((defeat) => (
        <span
          key={defeat.id}
          ref={(node) => { if (node) mobDefeatRefs.current.set(defeat.id, node); else mobDefeatRefs.current.delete(defeat.id) }}
          className={`mob-defeat${reducedMotion ? ' mob-defeat--reduced' : ''}`}
          data-testid="mob-defeat"
          aria-hidden="true"
        >✸</span>
      ))}
      {laserCells.map(({ key, className }) => (
        <span
          key={key}
          ref={(node) => { if (node) laserRefs.current.set(key, node); else laserRefs.current.delete(key) }}
          className={className}
          style={{ '--laser-flash': `${LASER_FLASH_MS}ms` } as CSSProperties}
          data-testid={className.split(' ')[0]}
          aria-hidden="true"
        />
      ))}
      {aimDirection && (
        <span className="visually-hidden" role="img" data-testid="laser-aim-label"
          aria-label={`Laser aimed ${aimDirection}, ${aimLane.length} squares${aimTarget ? ' to a target' : aimStop ? ' to the terrain' : ' to the map edge'}${sync.laserRecharging ? ', recharging' : ''}`} />
      )}
      {shot && (
        <span key={`${shot.shotId}-label`} className="visually-hidden" role="img" data-testid="laser-shot-label"
          aria-label={`${shot.shooterName ?? 'A player'} fired a laser ${shot.facing}, ${shot.path.length} squares${shotStop ? ' to the terrain' : ''}${shotVictims.length ? ', hitting a player' : shotMobHits.length ? ', hitting a mob' : ''}`} />
      )}
      {sync.dead && (
        <div className="death-screen" role="dialog" aria-modal="true" aria-label="You were defeated">
          <h2>You were obliterated{sync.attackerName && <> by <strong className="death-attacker">{sync.attackerName}</strong></>}.</h2>
          <p>Ready for another life?</p>
          <button type="button" disabled={blocked} onClick={sync.rejoin} aria-keyshortcuts="Space">Rejoin world <kbd aria-hidden="true">Space</kbd></button>
        </div>
      )}
      {token && player && !sync.dead && (
        <div className="game-action-controls" role="group" aria-label="Player actions">
          <button
            ref={avatarButtonRef}
            className="avatar-change-control"
            type="button"
            disabled={inputBlocked || !position}
            onClick={() => setAvatarModalOpen(true)}
          >Change avatar</button>
        </div>
      )}
      {inputMode === 'touch' && token && player && position && !sync.dead && (
        <VirtualControls
          disabled={inputBlocked}
          onMoveStart={startTouchMovement}
          onMoveEnd={stopTouchMovement}
          onFire={() => fireRef.current()}
          fireRecharging={sync.laserRecharging}
        />
      )}
      {sync.message && <p className="sync-message" role="status">{sync.message}
        {token && player && !position && !sync.dead && <button type="button" disabled={blocked} onClick={sync.retryPlacement}>Try joining again</button>}
      </p>}

      {!cleanView && <>
      <header className="brand-panel">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <p className="eyebrow">The shared frontier</p>
          <h1>Party Conquest</h1>
        </div>
      </header>

      <aside className="world-badge" aria-label="World information">
        <span className={`status-dot status-dot--${sync.state}`} />
        <span>World 01</span>
        <span className="badge-divider" />
        <span className="world-size">{MOVEMENT_WORLD.width} × {MOVEMENT_WORLD.height} blocks</span>
        <span className="badge-divider" />
        <span className="backend-status" aria-live="polite">
          {syncLabel(sync)}
        </span>
      </aside>

      <div className="navigation-help" aria-hidden="true">
        <span className="desktop-help">Scroll to pan · ⌘/Ctrl + scroll to zoom · Middle-drag to pan · Shift to sprint · R to taunt</span>
        <span className="mobile-help">Drag to pan · Pinch to zoom · Hold arrows to move</span>
      </div>
      </>}

      {fullscreen.error && <p className="view-notice" role="status">{fullscreen.error}</p>}

      <div className="control-dock">
        <button
          type="button"
          className={`how-to-play-button${howToPlayHighlight === 'on' ? ' how-to-play-button--highlight' : ''}`}
          aria-haspopup="dialog"
          onClick={() => { setHowToPlayHighlight(null); setHowToPlay('reopened') }}
        ><ControlIcon>?</ControlIcon><span>How to play</span></button>
        <nav className="view-controls" aria-label="View options">
          {cleanView
            ? <button type="button" className="restore-ui" aria-label="Restore UI" onClick={() => setCleanView(false)}><ControlIcon>▣</ControlIcon><span>Restore UI</span></button>
            : <>
              <button type="button" aria-label="Clean view" aria-pressed={false} onClick={() => setCleanView(true)}><ControlIcon>◻</ControlIcon><span>Clean view</span></button>
            </>}
          <button
            type="button"
            aria-pressed={fullscreen.active}
            aria-label={fullscreen.active ? 'Exit fullscreen' : 'Enter fullscreen'}
            disabled={!fullscreen.supported}
            title={fullscreen.supported ? undefined : 'Fullscreen is not available in this browser'}
            onClick={() => void fullscreen.toggle()}
          ><ControlIcon>{fullscreen.active ? '⤡' : '⤢'}</ControlIcon><span>{fullscreen.active ? 'Exit fullscreen' : 'Fullscreen'}</span></button>
        </nav>
        <nav className="map-controls" aria-label="Map navigation" aria-hidden={inputBlocked}>
          <button type="button" disabled={inputBlocked} onClick={() => zoomFromCenter(ZOOM_STEP)} aria-label="Zoom in">
            <ControlIcon>+</ControlIcon>
          </button>
          <output aria-live="polite" aria-label={`Current zoom ${zoomLabel}`}>
            {zoomLabel}
          </output>
          <button type="button" disabled={inputBlocked} onClick={() => zoomFromCenter(1 / ZOOM_STEP)} aria-label="Zoom out">
            <ControlIcon>−</ControlIcon>
          </button>
          <span className="control-divider" />
          {position && <button type="button" disabled={inputBlocked} className="fit-button" aria-label="Return to player" onClick={() => focusPlayer(position)}>
            <ControlIcon>◎</ControlIcon><span>My player</span>
          </button>}
          <button type="button" disabled={inputBlocked} className="fit-button" onClick={toggleFitWorld} aria-pressed={fitWorldActive} aria-label="Fit world in view">
            <ControlIcon>⌗</ControlIcon>
            <span>Fit world</span>
          </button>
        </nav>
      </div>
      {avatarPickerOpen && player && (
        <AvatarChangeModal
          current={currentAvatar ?? player.avatar}
          custom={player.customAvatar}
          inUse={avatarAvailability.inUse}
          required={sync.avatarConflict}
          onSave={saveAvatar}
          onUpload={uploadAvatar}
          onCancel={closeAvatarModal}
        />
      )}
      {sync.state !== 'connected' && <ConnectionScreen state={sync.state} />}
      {howToPlay && <HowToPlayPanel inputMode={inputMode} onClose={closeHowToPlay} />}
    </section>
  )
}
