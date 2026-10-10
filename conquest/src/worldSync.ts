import { backendUrl } from './backend'
import { ApiError } from './session/api'

/** The single shared world every client joins. */
export const DEFAULT_WORLD_ID = 'world-01'
export const WORLD_PROTOCOL_VERSION = 1
export const WORLD_SCHEMA_VERSION = 2
export const SNAPSHOT_TIMEOUT_MS = 5000

export type SyncState = 'connected' | 'reconnecting' | 'syncing' | 'unavailable'
/** Private frames from retired features; a server mid-rollout may still send them, so they are ignored without a resync. */
const RETIRED_FRAMES = new Set(['specialStatus', 'powerUpStatus', 'nitroStatus', 'treasureHunt'])

/** A live-only cosmetic broadcast: never revisioned, persisted, or replayed. */
export type Taunt = { worldId: string; playerId: string }

export type WorldEvent = {
  protocolVersion: number
  schemaVersion: number
  type: 'event'
  worldId: string
  revision: number
  eventType: string
  commandId: string
  payload: Record<string, unknown>
  committedAt: string
}

export type Snapshot = {
  protocolVersion: number
  schemaVersion: number
  worldId: string
  revision: number
  serverTime?: string
  state: Record<string, unknown>
}

type SocketLike = {
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void
  send(data: string): void
  close(): void
}

export type WorldSyncOptions = {
  worldId: string
  getToken?: () => string | null
  onEvent: (event: WorldEvent) => void
  onTaunt?: (taunt: Taunt) => void
  /** Private: the saved avatar is held by another connected player and must be replaced before spawning. */
  onAvatarConflict?: () => void
  onSnapshot?: (snapshot: Snapshot) => void
  onStateChange?: (state: SyncState) => void
  fetch?: typeof fetch
  createSocket?: (url: string) => SocketLike
  minBackoffMs?: number
  maxBackoffMs?: number
}

export function websocketUrl(
  url: string,
  baseUrl = typeof window === 'undefined' ? undefined : window.location.href,
): string {
  const parsed = new URL(url, baseUrl)
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return parsed.toString()
}

/** Owns snapshot bootstrap, ordered replay, deduplication, and resilient reconnects. */
export class WorldSynchronizer {
  private readonly options: WorldSyncOptions
  private revision = 0
  private socket?: SocketLike
  private stopped = true
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private backoffMs: number
  private generation = 0
  private cancelBootstrap?: () => void
  private connected = false
  /** The server accepts moves and turns over this socket (advertised on `ready`). */
  private commands = false
  private readonly pendingCommands = new Map<string, { resolve: (result: { event: WorldEvent }) => void; reject: (error: Error) => void }>()

  constructor(options: WorldSyncOptions) {
    this.options = options
    this.backoffMs = options.minBackoffMs ?? 500
  }

  get lastAppliedRevision(): number {
    return this.revision
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.bootstrap()
  }

  stop(): void {
    this.stopped = true
    this.connected = false
    this.generation += 1
    this.cancelBootstrap?.()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.rejectCommands()
  }

  get commandsAvailable(): boolean {
    return this.connected && this.commands && this.socket !== undefined
  }

  /**
   * Submit a move or turn over the open stream. Resolves with the committed
   * event once it is applied from the stream; rejects with the server's
   * rejection, or when the stream closes with the outcome unknown.
   */
  sendCommand(actionType: string, payload: Record<string, unknown>, id: string, signal?: AbortSignal): Promise<{ event: WorldEvent }> {
    const socket = this.socket
    if (!this.commandsAvailable || !socket) return Promise.reject(new Error('World stream is not connected'))
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pendingCommands.delete(id)
        reject(new DOMException('Command aborted', 'AbortError'))
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      const settle = <T,>(finish: (value: T) => void) => (value: T) => {
        signal?.removeEventListener('abort', abort)
        this.pendingCommands.delete(id)
        finish(value)
      }
      this.pendingCommands.set(id, { resolve: settle(resolve), reject: settle(reject) })
      socket.send(JSON.stringify({
        protocolVersion: WORLD_PROTOCOL_VERSION, schemaVersion: WORLD_SCHEMA_VERSION,
        type: 'command', commandId: id, actionType, payload,
      }))
    })
  }

  /** Broadcast a taunt to every connected player; false while the stream is not connected. */
  sendTaunt(): boolean {
    if (!this.connected || !this.socket) return false
    this.socket.send(JSON.stringify({
      protocolVersion: WORLD_PROTOCOL_VERSION, schemaVersion: WORLD_SCHEMA_VERSION,
      type: 'taunt', worldId: this.options.worldId,
    }))
    return true
  }

  private rejectCommands(): void {
    this.commands = false
    for (const pending of [...this.pendingCommands.values()]) pending.reject(new Error('World stream closed before the command settled'))
  }

  private setState(state: SyncState): void {
    this.options.onStateChange?.(state)
  }

  private async bootstrap(): Promise<void> {
    this.cancelBootstrap?.()
    const generation = ++this.generation
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (this.stopped || generation !== this.generation) return
      this.generation += 1
      controller.abort()
      this.scheduleReconnect(true)
    }, SNAPSHOT_TIMEOUT_MS)
    this.cancelBootstrap = () => { clearTimeout(timer); controller.abort() }
    this.setState('syncing')
    try {
      const response = await (this.options.fetch ?? fetch)(
        backendUrl(`/v1/worlds/${encodeURIComponent(this.options.worldId)}/snapshot`),
        { signal: controller.signal },
      )
      if (!response.ok) throw new Error(`Snapshot failed with HTTP ${response.status}`)
      const snapshot = (await response.json()) as Snapshot
      if (snapshot.protocolVersion !== WORLD_PROTOCOL_VERSION || snapshot.schemaVersion !== WORLD_SCHEMA_VERSION || snapshot.worldId !== this.options.worldId) {
        throw new Error('Unsupported snapshot contract')
      }
      if (this.stopped || generation !== this.generation) return
      this.revision = snapshot.revision
      this.options.onSnapshot?.(snapshot)
      this.connect()
    } catch {
      if (!this.stopped && generation === this.generation) this.scheduleReconnect(true)
    } finally {
      clearTimeout(timer)
    }
  }

  private connect(): void {
    const url = websocketUrl(
      backendUrl(`/v1/worlds/${encodeURIComponent(this.options.worldId)}/events?after=${this.revision}`),
    )
    const socket = (this.options.createSocket ?? ((value) => new WebSocket(value)))(url)
    this.socket = socket
    socket.addEventListener('open', () => {
      if (socket !== this.socket || this.stopped) return
      this.backoffMs = this.options.minBackoffMs ?? 500
      socket.send(JSON.stringify({ protocolVersion: WORLD_PROTOCOL_VERSION, schemaVersion: WORLD_SCHEMA_VERSION, type: 'auth', token: this.options.getToken?.() ?? null, features: ['batch'] }))
      this.setState('syncing')
    })
    socket.addEventListener('message', (raw) => {
      if (socket !== this.socket || this.stopped) return
      this.handleMessage((raw as MessageEvent).data)
    })
    socket.addEventListener('close', () => {
      this.connected = false
      if (socket !== this.socket) return
      this.rejectCommands()
      if (!this.stopped) this.scheduleReconnect(true)
    })
    socket.addEventListener('error', () => {
      if (socket === this.socket) socket.close()
    })
  }

  private handleMessage(raw: unknown): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      this.forceResync()
      return
    }
    if (message.protocolVersion !== WORLD_PROTOCOL_VERSION || message.schemaVersion !== WORLD_SCHEMA_VERSION) {
      this.forceResync()
      return
    }
    if (message.type === 'ping') {
      this.socket?.send(JSON.stringify({ protocolVersion: WORLD_PROTOCOL_VERSION, schemaVersion: WORLD_SCHEMA_VERSION, type: 'pong' }))
      return
    }
    if (message.type === 'ready') {
      if (message.worldId !== this.options.worldId || message.revision !== this.revision) this.forceResync()
      else {
        this.connected = true
        this.commands = Array.isArray(message.features) && message.features.includes('commands')
        this.setState('connected')
      }
      return
    }
    if (typeof message.type === 'string' && RETIRED_FRAMES.has(message.type)) return
    if (message.type === 'taunt') {
      if (message.worldId === this.options.worldId && typeof message.playerId === 'string') {
        this.options.onTaunt?.({ worldId: message.worldId, playerId: message.playerId })
      }
      return
    }
    if (message.type === 'avatarStatus') {
      if (message.available === false) this.options.onAvatarConflict?.()
      return
    }
    if (message.type === 'commandError') {
      // A rejected socket command settles only its caller; the world stream is unaffected.
      const error = (message.error ?? {}) as { code?: string; message?: string }
      const status = typeof message.status === 'number' ? message.status : 400
      this.pendingCommands.get(String(message.commandId))?.reject(
        new ApiError(status, error.code ?? 'position-command-failed', error.message ?? `Position command failed (${status})`),
      )
      return
    }
    if (message.type === 'batch') {
      // One frame per server tick; each event keeps the same ordering and gap rules.
      if (message.worldId !== this.options.worldId || !Array.isArray(message.events)) {
        this.forceResync()
        return
      }
      for (const event of message.events as Record<string, unknown>[]) {
        if (!this.applyEvent(event)) return
      }
      return
    }
    if (message.error) {
      const code = (message.error as { code?: string }).code
      if (code === 'stale_cursor' || code === 'resync_required') this.forceResync()
      else this.setState('unavailable')
      return
    }
    this.applyEvent(message)
  }

  /** Applies one ordered event; returns false when the stream had to be re-established. */
  private applyEvent(message: Record<string, unknown>): boolean {
    if (message.type !== 'event' || message.worldId !== this.options.worldId || !Number.isSafeInteger(message.revision)) {
      this.forceResync()
      return false
    }
    const event = message as unknown as WorldEvent
    if (event.revision <= this.revision) return true
    if (event.revision !== this.revision + 1) {
      this.reconnectFromCursor()
      return false
    }
    this.options.onEvent(event)
    this.revision = event.revision
    this.pendingCommands.get(event.commandId)?.resolve({ event })
    return true
  }

  private reconnectFromCursor(): void {
    this.connected = false
    this.rejectCommands()
    this.setState('syncing')
    const old = this.socket
    this.socket = undefined
    old?.close()
    if (!this.stopped) this.connect()
  }

  forceResync(): void {
    this.connected = false
    this.rejectCommands()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const old = this.socket
    this.socket = undefined
    old?.close()
    if (!this.stopped) void this.bootstrap()
  }

  private scheduleReconnect(bootstrap = false): void {
    if (this.reconnectTimer || this.stopped) return
    const wait = this.backoffMs
    const maximum = this.options.maxBackoffMs ?? 15_000
    this.setState(wait >= maximum ? 'unavailable' : 'reconnecting')
    this.backoffMs = Math.min(maximum, this.backoffMs * 2)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopped) {
        if (bootstrap) void this.bootstrap()
        else this.connect()
      }
    }, wait)
  }
}
