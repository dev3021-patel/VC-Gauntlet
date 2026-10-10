import { describe, expect, it, vi } from 'vitest'
import { SNAPSHOT_TIMEOUT_MS, websocketUrl, WorldSynchronizer, type WorldEvent } from './worldSync'

class FakeSocket {
  listeners = new Map<string, ((event: Event | MessageEvent) => void)[]>()
  sent: string[] = []
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(data: string) { this.sent.push(data) }
  close() { this.emit('close', new Event('close')) }
  emit(type: string, event: Event | MessageEvent) { this.listeners.get(type)?.forEach((listener) => listener(event)) }
  message(value: object) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) })) }
}

const event = (revision: number): WorldEvent => ({
  protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision,
  eventType: 'transport.tested', commandId: `c${revision}`, payload: {}, committedAt: '',
})

async function setup(token: string | null = null) {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const applied: number[] = []
  const states: string[] = []
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ protocolVersion: 1, schemaVersion: 2, worldId: 'world-01', revision: 2, state: {} }) })
  const sync = new WorldSynchronizer({ worldId: 'world-01', getToken: () => token, onEvent: (value) => applied.push(value.revision), onStateChange: (state) => states.push(state), fetch, createSocket: (url) => { const socket = new FakeSocket(); sockets.push(socket); urls.push(url); return socket }, minBackoffMs: 1 })
  sync.start()
  await vi.waitFor(() => expect(sockets).toHaveLength(1))
  return { sync, sockets, urls, applied, fetch, states }
}

describe('WorldSynchronizer', () => {
  it('resolves a same-origin Preview path before converting it to WebSocket', () => {
    expect(websocketUrl('/api/v1/worlds/world-01/events?after=0', 'https://preview.example/')).toBe(
      'wss://preview.example/api/v1/worlds/world-01/events?after=0',
    )
  })

  it('reports connected only after replay is ready', async () => {
    const { sync, sockets, states } = await setup()
    sockets[0].emit('open', new Event('open'))
    expect(states.at(-1)).toBe('syncing')
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 2 })
    expect(states.at(-1)).toBe('connected')
    sync.stop()
  })

  it('sends credentials in the first frame without putting them in the websocket URL', async () => {
    const { sync, sockets, urls } = await setup('secret-token')
    sockets[0].emit('open', new Event('open'))
    expect(urls[0]).not.toContain('secret-token')
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ protocolVersion: 1, schemaVersion: 2, type: 'auth', token: 'secret-token', features: ['batch'] })
    sync.stop()
  })

  it('applies tick batches in order and settles socket commands from the stream or their rejection', async () => {
    const { sync, sockets, applied } = await setup('token')
    sockets[0].emit('open', new Event('open'))
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 2, features: ['batch', 'commands'] })
    expect(sync.commandsAvailable).toBe(true)
    const moved = sync.sendCommand('player.move', { expectedRevision: 1 }, 'c4')
    const blocked = sync.sendCommand('player.move', { expectedRevision: 1 }, 'blocked')
    expect(JSON.parse(sockets[0].sent.at(-2)!)).toMatchObject({ type: 'command', commandId: 'c4', actionType: 'player.move' })
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'batch', worldId: 'world-01', events: [event(2), event(3), event(4)] })
    expect(applied).toEqual([3, 4])
    await expect(moved).resolves.toMatchObject({ event: { revision: 4 } })
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'commandError', commandId: 'blocked', status: 409, error: { code: 'occupied', message: 'Destination is occupied' } })
    await expect(blocked).rejects.toMatchObject({ status: 409, code: 'occupied' })
    expect(sockets).toHaveLength(1)
    // A gap inside a batch reconnects from the cursor and fails commands whose outcome is unknown.
    const lost = sync.sendCommand('player.move', {}, 'c9')
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'batch', worldId: 'world-01', events: [event(5), event(7)] })
    expect(applied).toEqual([3, 4, 5])
    await expect(lost).rejects.toThrow('closed')
    expect(sync.commandsAvailable).toBe(false)
    sync.stop()
  })

  it('deduplicates revisions and applies ordered events once', async () => {
    const { sync, sockets, applied } = await setup()
    sockets[0].message(event(3)); sockets[0].message(event(3)); sockets[0].message(event(4))
    expect(applied).toEqual([3, 4])
    expect(sync.lastAppliedRevision).toBe(4)
    sync.stop()
  })

  it('detects a gap and reconnects from the last applied revision', async () => {
    const { sync, sockets, urls } = await setup()
    expect(urls[0]).toContain('after=2')
    sockets[0].message(event(4))
    expect(sockets).toHaveLength(2)
    expect(urls[1]).toContain('after=2')
    sync.stop()
  })

  it('reconnects after disconnect with bounded backoff', async () => {
    const { sync, sockets, states } = await setup()
    sockets[0].close()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    expect(states).toContain('reconnecting')
    sync.stop()
  })

  it('loads a fresh snapshot when retained history is unavailable', async () => {
    const { sync, sockets, fetch } = await setup()
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, error: { code: 'stale_cursor' } })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    sync.stop()
  })

  it('answers application heartbeats', async () => {
    const { sync, sockets } = await setup()
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ping' })
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ protocolVersion: 1, schemaVersion: 2, type: 'pong' })
    sync.stop()
  })

  it('ignores retired private frames without resyncing or moving the cursor', async () => {
    const { sync, sockets, fetch } = await setup()
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 2 })
    for (const type of ['specialStatus', 'powerUpStatus', 'nitroStatus', 'treasureHunt']) {
      sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type, worldId: 'world-01', playerId: 'p2' })
    }
    expect(sockets).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sync.lastAppliedRevision).toBe(2)
    sync.stop()
  })

  it('sends taunts only while connected and delivers revisionless taunts without moving the cursor', async () => {
    const onTaunt = vi.fn()
    const sockets: FakeSocket[] = []
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ protocolVersion: 1, schemaVersion: 2, worldId: 'world-01', revision: 2, state: {} }) })
    const sync = new WorldSynchronizer({ worldId: 'world-01', onEvent: vi.fn(), onTaunt, fetch, createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket } })
    sync.start()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    expect(sync.sendTaunt()).toBe(false)
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 2 })
    expect(sync.sendTaunt()).toBe(true)
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ protocolVersion: 1, schemaVersion: 2, type: 'taunt', worldId: 'world-01' })
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'taunt', worldId: 'world-01', playerId: 'p2' })
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'taunt', worldId: 'world-02', playerId: 'p3' })
    expect(onTaunt).toHaveBeenCalledTimes(1)
    expect(onTaunt).toHaveBeenCalledWith({ worldId: 'world-01', playerId: 'p2' })
    expect(sockets).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sync.lastAppliedRevision).toBe(2)
    sync.stop()
    expect(sync.sendTaunt()).toBe(false)
  })

  it('reports a contested saved avatar from the private status frame without moving the cursor', async () => {
    const onAvatarConflict = vi.fn()
    const sockets: FakeSocket[] = []
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ protocolVersion: 1, schemaVersion: 2, worldId: 'world-01', revision: 2, state: {} }) })
    const sync = new WorldSynchronizer({ worldId: 'world-01', getToken: () => 'token', onEvent: vi.fn(), onAvatarConflict, fetch, createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket } })
    sync.start()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'avatarStatus', worldId: 'world-01', available: true, avatar: 'moss' })
    expect(onAvatarConflict).not.toHaveBeenCalled()
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'avatarStatus', worldId: 'world-01', available: false, avatar: 'moss' })
    expect(onAvatarConflict).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
    expect(sync.lastAppliedRevision).toBe(2)
    sync.stop()
  })
})


it('bounds a hung snapshot and discards it if it completes after recovery', async () => {
  vi.useFakeTimers()
  let finish!: (response: Response) => void
  const snapshot = { protocolVersion: 1, schemaVersion: 2, worldId: 'world-01', revision: 2, state: {} }
  const fetch = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    .mockResolvedValue({ ok: true, json: async () => snapshot })
  const onSnapshot = vi.fn()
  const sync = new WorldSynchronizer({ worldId: 'world-01', fetch, onSnapshot, onEvent: () => {},
    createSocket: () => new FakeSocket(), minBackoffMs: 1 })
  try {
    sync.start()
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS + 1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot)
    finish(new Response(JSON.stringify({ ...snapshot, revision: 1 })))
    await vi.advanceTimersByTimeAsync(0)
    expect(onSnapshot).toHaveBeenCalledTimes(1)
  } finally { sync.stop(); vi.useRealTimers() }
})
