// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Player } from './session/types'
import { MOVE_TIMEOUT_MS, useWorldSync } from './useWorldSync'
import { LASER_COOLDOWN_MS, LASER_FLASH_MS } from './laser'

class FakeSocket {
  listeners = new Map<string, ((event: Event | MessageEvent) => void)[]>()
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send() {}
  close() { this.emit('close', new Event('close')) }
  emit(type: string, event: Event | MessageEvent) { this.listeners.get(type)?.forEach((listener) => listener(event)) }
  message(value: object) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) })) }
}

const player: Player = { id: 'p1', name: 'Marlowe', avatar: 'moss', customAvatar: null, createdAt: 1, lastSeenAt: 2 }
const shared = (playerId: string, x: number, y: number, positionRevision = 1) => ({
  playerId, name: playerId === 'p1' ? 'Marlowe' : 'Wren', avatar: playerId === 'p1' ? 'moss' : 'tide',
  x, y, positionRevision, facing: 'south' as const,
})
const worldEvent = (revision: number, payload: ReturnType<typeof shared> & { firstSpawn?: boolean }) => ({
  protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision,
  eventType: 'player.moved', commandId: `c${revision}`, payload, committedAt: '',
})

function setup(options: {
  initialPlayer?: Player | null
  snapshots?: ReturnType<typeof shared>[][]
  deathAttribution?: Record<string, unknown>
  eliminated?: Record<string, number>
  state?: Record<string, unknown>
  post?: (payload: Record<string, unknown>, actionType: string) => Promise<{ ok: boolean; body: unknown }> | { ok: boolean; body: unknown }
} = {}) {
  const sockets: FakeSocket[] = []
  const commands: Record<string, unknown>[] = []
  const actionTypes: string[] = []
  const meRequests: string[] = []
  let snapshotIndex = 0
  const snapshots = options.snapshots ?? [[shared('p1', 11, 4), shared('p2', 13, 4)]]
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/snapshot')) {
      const players = snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]
      return new Response(JSON.stringify({
        protocolVersion: 1, schemaVersion: 2, worldId: 'world-01', revision: snapshotIndex,
        serverTime: '2030-01-01T00:00:00.000Z',
        state: { players, eliminated: options.eliminated, deathAttribution: options.deathAttribution, ...options.state },
      }), { status: 200 })
    }
    if (path.endsWith('/players/me')) {
      meRequests.push(String((init.headers as Record<string, string> | undefined)?.Authorization))
      return new Response(JSON.stringify({ player }), { status: 200 })
    }
    const command = JSON.parse(String(init.body)) as { actionType: string; payload: Record<string, unknown> }
    commands.push(command.payload)
    actionTypes.push(command.actionType)
    const destination = command.payload.destination as { x: number; y: number }
    const result = await (options.post?.(command.payload, command.actionType) ?? {
      ok: true, body: { event: worldEvent(2, shared('p1', destination.x, destination.y, 2)) },
    })
    return new Response(JSON.stringify(result.body), { status: result.ok ? 201 : 409 })
  }) as unknown as typeof fetch
  const createSocket = () => { const socket = new FakeSocket(); sockets.push(socket); return socket }
  const hook = renderHook(({ currentPlayer, currentWorld }) => useWorldSync(currentWorld, {
    player: currentPlayer, token: 'token', fetchImpl, minBackoffMs: 1, createSocket,
  }), { initialProps: { currentPlayer: options.initialPlayer === undefined ? player : options.initialPlayer, currentWorld: 'world-01' } })
  return { ...hook, sockets, commands, actionTypes, fetchImpl, meRequests }
}

async function ready(sockets: FakeSocket[], index: number, revision: number) {
  await waitFor(() => expect(sockets.length).toBeGreaterThan(index))
  act(() => sockets[index].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision }))
}

beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

describe('useWorldSync blocking recovery', () => {
  it('stays non-interactive until snapshot replay is ready', async () => {
    const { result, sockets, commands } = setup()
    expect(result.current.state).toBe('syncing')
    act(() => result.current.move('south'))
    expect(commands).toHaveLength(0)
    await ready(sockets, 0, 1)
    expect(result.current.state).toBe('connected')
  })

  it('submits one adjacent movement block per command', async () => {
    const { result, sockets, commands } = setup()
    await ready(sockets, 0, 1)
    act(() => result.current.move('south'))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toMatchObject({
      expected: { x: 11, y: 4 },
      destination: { x: 11, y: 5 },
      expectedRevision: 1,
    })
  })

  it('clears an old queue and ignores movement throughout disconnect recovery', async () => {
    localStorage.setItem('party-conquest.moves.world-01.p1', '[{"old":true}]')
    const { result, sockets, commands, fetchImpl } = setup({
      snapshots: [[shared('p1', 11, 4)], [shared('p1', 12, 4, 2)]],
    })
    await ready(sockets, 0, 1)
    expect(localStorage.getItem('party-conquest.moves.world-01.p1')).toBeNull()
    act(() => sockets[0].close())
    act(() => result.current.move('south'))
    expect(commands).toHaveLength(0)
    await ready(sockets, 1, 2)
    await waitFor(() => expect(result.current.state).toBe('connected'))
    expect(result.current.position).toMatchObject({ x: 12, y: 4 })
    expect(vi.mocked(fetchImpl).mock.calls.filter(([input]) => String(input).endsWith('/snapshot'))).toHaveLength(2)
  })

  it('resolves an ambiguous in-flight move from recovery state without resubmitting', async () => {
    let resolveMove!: (value: { ok: boolean; body: unknown }) => void
    const pending = new Promise<{ ok: boolean; body: unknown }>((resolve) => { resolveMove = resolve })
    const { result, sockets, commands } = setup({
      snapshots: [[shared('p1', 11, 4)], [shared('p1', 11, 5, 2)]],
      post: () => pending,
    })
    await ready(sockets, 0, 1)
    act(() => result.current.move('south'))
    await waitFor(() => expect(commands).toHaveLength(1))
    act(() => sockets[0].close())
    resolveMove({ ok: true, body: { event: worldEvent(2, shared('p1', 11, 5, 2)) } })
    await ready(sockets, 1, 2)
    await waitFor(() => expect(result.current.position).toMatchObject({ x: 11, y: 5 }))
    expect(commands).toHaveLength(1)
  })

  it('keeps confirmed state and reports an occupied connected move', async () => {
    const { result, sockets } = setup({ post: () => ({
      ok: false, body: { error: { code: 'occupied', message: 'Destination is occupied' } },
    }) })
    await ready(sockets, 0, 1)
    act(() => result.current.move('south'))
    await waitFor(() => expect(result.current.message).toBe('Destination is occupied'))
    expect(result.current.position).toMatchObject({ x: 11, y: 4 })
  })

  it('applies ordered remote-player events without changing the local marker', async () => {
    const { result, sockets } = setup()
    await ready(sockets, 0, 1)
    act(() => sockets[0].message(worldEvent(2, shared('p2', 13, 5, 2))))
    expect(result.current.players.find((item) => item.playerId === 'p2')).toMatchObject({ x: 13, y: 5 })
    expect(result.current.position).toMatchObject({ x: 11, y: 4 })
  })

  it('emits independent reveals for live spawns and combat rejoins, and deduplicates delivery', async () => {
    const { result, sockets } = setup({ snapshots: [[shared('p1', 11, 4)]] })
    await ready(sockets, 0, 1)
    const first = {
      ...worldEvent(2, { ...shared('p2', 13, 5, 2), firstSpawn: true }),
      eventType: 'player.placed',
    }
    const second = {
      ...worldEvent(3, { ...shared('p3', 15, 6, 3), firstSpawn: true }),
      eventType: 'player.placed',
    }
    act(() => {
      sockets[0].message(first)
      sockets[0].message(first)
      sockets[0].message(second)
    })
    expect(result.current.spawnReveals).toEqual([
      { id: 'c2:2', playerId: 'p2', x: 13, y: 5 },
      { id: 'c3:3', playerId: 'p3', x: 15, y: 6 },
    ])

    const rejoin = {
      ...worldEvent(4, { ...shared('p2', 20, 10, 4), firstSpawn: false }),
      eventType: 'player.placed',
    }
    act(() => {
      sockets[0].message(rejoin)
      sockets[0].message(rejoin)
    })
    expect(result.current.spawnReveals.at(-1)).toEqual({ id: 'c4:4', playerId: 'p2', x: 20, y: 10 })
    expect(result.current.spawnReveals).toHaveLength(3)

    act(() => sockets[0].message({
      ...worldEvent(5, { ...shared('p2', 21, 10, 5) }),
      eventType: 'player.placed',
    }))
    expect(result.current.spawnReveals).toHaveLength(3)
    // Replayed legacy respawns update the marker without a reveal.
    act(() => sockets[0].message({ ...worldEvent(6, shared('p2', 22, 10, 6)), eventType: 'player.respawned' }))
    expect(result.current.spawnReveals).toHaveLength(3)
    expect(result.current.players.find((item) => item.playerId === 'p2')).toMatchObject({ x: 22, y: 10 })
    await waitFor(() => expect(result.current.spawnReveals).toEqual([]), { timeout: 1_100 })
  })

  it('reveals the local player on their own live first placement', async () => {
    const { result, sockets } = setup({
      snapshots: [[]],
      post: () => ({
        ok: true,
        body: { event: { ...worldEvent(2, { ...shared('p1', 11, 4, 2), firstSpawn: true }), eventType: 'player.placed' } },
      }),
    })
    await ready(sockets, 0, 1)
    await waitFor(() => expect(result.current.position).toMatchObject({ x: 11, y: 4 }))
    expect(result.current.spawnReveals).toEqual([{ id: 'c2:2', playerId: 'p1', x: 11, y: 4 }])
  })

  it('does not reconstruct a reveal from snapshot hydration', async () => {
    const hydrated = { ...shared('p2', 13, 5), firstSpawn: true }
    const { result, sockets } = setup({ snapshots: [[shared('p1', 11, 4), hydrated]] })
    await ready(sockets, 0, 1)
    expect(result.current.spawnReveals).toEqual([])
  })

  it('suppresses eligible arrivals delivered during reconnect catch-up before ready', async () => {
    const { result, sockets } = setup({ snapshots: [[shared('p1', 11, 4)], [shared('p1', 11, 4)]] })
    await ready(sockets, 0, 1)
    act(() => sockets[0].close())
    await waitFor(() => expect(sockets).toHaveLength(2))
    act(() => {
      sockets[1].message({
        ...worldEvent(3, { ...shared('p2', 13, 5, 3), firstSpawn: true }),
        eventType: 'player.placed',
      })
      sockets[1].message({
        ...worldEvent(4, { ...shared('p3', 15, 6, 4), firstSpawn: false }),
        eventType: 'player.placed',
      })
    })
    expect(result.current.spawnReveals).toEqual([])
    await ready(sockets, 1, 5)
    expect(result.current.spawnReveals).toEqual([])
  })

  it('allows movement and firing while another player has active arrival smoke', async () => {
    const { result, sockets, actionTypes } = setup({ post: () => new Promise(() => {}) })
    await ready(sockets, 0, 1)
    act(() => sockets[0].message({
      ...worldEvent(2, { ...shared('p2', 13, 5, 2), firstSpawn: true }),
      eventType: 'player.placed',
    }))
    expect(result.current.spawnReveals).toHaveLength(1)
    act(() => { result.current.fire(); result.current.move('south') })
    await waitFor(() => expect([...actionTypes].sort()).toEqual(['player.move', 'player.shoot']))
    expect(result.current.spawnReveals).toHaveLength(1)
  })

  it('holds a laser pressed mid-move until the move settles, then fires the requested heading from the new cell', async () => {
    let confirmMove!: (value: { ok: boolean; body: unknown }) => void
    const { result, sockets, commands, actionTypes } = setup({
      post: (payload, actionType) => actionType === 'player.move'
        ? new Promise((resolve) => { confirmMove = resolve })
        : { ok: true, body: { event: { ...worldEvent(3, shared('p1', 11, 5, 2)), eventType: 'player.shot', payload: {
          shotId: 'laser-1', shooterId: 'p1', facing: payload.facing, origin: { x: 11, y: 5 }, path: [], victim: null,
        } } } },
    })
    await ready(sockets, 0, 1)
    act(() => { result.current.move('south'); result.current.fire('east') })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(actionTypes).toEqual(['player.move'])

    confirmMove({ ok: true, body: { event: worldEvent(2, shared('p1', 11, 5, 2)) } })
    await waitFor(() => expect(actionTypes).toEqual(['player.move', 'player.shoot']))
    expect(commands[1]).toMatchObject({ facing: 'east', expectedRevision: 2 })
  })

  it('fires once per press, then ignores presses until the one-second recharge ends', async () => {
    const { result, sockets, actionTypes } = setup({ post: () => ({ ok: true, body: { event: { ...worldEvent(2 + actionTypes.length, shared('p1', 11, 4)), eventType: 'player.shot', payload: {
      shotId: `shot-${actionTypes.length}`, shooterId: 'p1', facing: 'north', origin: { x: 11, y: 4 }, path: [], victim: null,
    } } } }) })
    await ready(sockets, 0, 1)
    act(() => { result.current.fire('north'); result.current.fire('north') })
    await waitFor(() => expect(actionTypes).toEqual(['player.shoot']))
    expect(result.current.laserRecharging).toBe(true)
    act(() => result.current.fire('north'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(actionTypes).toHaveLength(1)

    await waitFor(() => expect(result.current.laserRecharging).toBe(false), { timeout: LASER_COOLDOWN_MS + 1000 })
    act(() => result.current.fire('north'))
    await waitFor(() => expect(actionTypes).toHaveLength(2))
  })

  it('treats a server recharge rejection as an early press, not an error', async () => {
    const { result, sockets, actionTypes } = setup({ post: () => ({ ok: false, body: {
      protocolVersion: 1, schemaVersion: 2, error: { code: 'shot_cooldown', message: 'Your laser is recharging', details: { retryAfterMs: 200 } },
    } }) })
    await ready(sockets, 0, 1)
    act(() => result.current.fire('north'))
    await waitFor(() => expect(actionTypes).toEqual(['player.shoot']))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.current.message).toBeNull()
    expect(result.current.laserRecharging).toBe(true)
  })

  it('omits the facing when none is requested so the server uses the committed heading', async () => {
    const { result, sockets, commands } = setup({ post: () => new Promise(() => {}) })
    await ready(sockets, 0, 1)
    act(() => result.current.fire())
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).not.toHaveProperty('facing')
  })

  it('clears a laser flash after its brief lifetime', async () => {
    const { result, sockets } = setup()
    await ready(sockets, 0, 1)
    act(() => sockets[0].message({ ...worldEvent(2, shared('p1', 11, 4)), eventType: 'player.shot', payload: {
      shotId: 'flash-1', shooterId: 'p2', facing: 'west', origin: { x: 13, y: 4 }, path: [{ x: 12, y: 4 }], victim: null,
    } }))
    expect(result.current.shot?.shotId).toBe('flash-1')
    await waitFor(() => expect(result.current.shot).toBeNull(), { timeout: LASER_FLASH_MS + 1000 })
  })

  it('removes an active arrival reveal when switching worlds', async () => {
    const { result, sockets, rerender } = setup()
    await ready(sockets, 0, 1)
    act(() => sockets[0].message({
      ...worldEvent(2, { ...shared('p2', 13, 5, 2), firstSpawn: true }),
      eventType: 'player.placed',
    }))
    expect(result.current.spawnReveals).toHaveLength(1)

    rerender({ currentPlayer: player, currentWorld: 'world-02' })
    expect(result.current.spawnReveals).toEqual([])
  })

  it('submits placement once despite remote events and latches a terminal rejection', async () => {
    let rejectPlacement!: (value: { ok: boolean; body: unknown }) => void
    const pending = new Promise<{ ok: boolean; body: unknown }>((resolve) => { rejectPlacement = resolve })
    const { result, sockets, commands } = setup({ snapshots: [[]], post: () => pending })
    await ready(sockets, 0, 1)
    await waitFor(() => expect(commands).toHaveLength(1))

    act(() => sockets[0].message(worldEvent(2, shared('p2', 13, 5, 2))))
    expect(commands).toHaveLength(1)
    rejectPlacement({ ok: false, body: { error: { code: 'no_spawn_available', message: 'No land cell is available' } } })
    await waitFor(() => expect(result.current.message).toBe('No land cell is available'))

    act(() => sockets[0].message(worldEvent(3, shared('p2', 13, 6, 3))))
    expect(commands).toHaveLength(1)
  })

  it('retries a transient placement failure after a clean reconnect', async () => {
    let attempts = 0
    const { result, sockets, commands } = setup({
      snapshots: [[], []],
      post: () => {
        attempts += 1
        if (attempts === 1) throw new TypeError('Failed to fetch')
        return {
          ok: true,
          body: { event: { ...worldEvent(3, shared('p1', 11, 4)), eventType: 'player.placed' } },
        }
      },
    })
    await ready(sockets, 0, 1)
    await waitFor(() => expect(result.current.message).toBe('Failed to fetch'))
    act(() => sockets[0].close())
    await ready(sockets, 1, 2)

    await waitFor(() => expect(result.current.position).toMatchObject({ x: 11, y: 4 }))
    expect(commands).toHaveLength(2)
  })

  it('fires once for a double press, consumes one death event, locks out the victim, and permits re-entry', async () => {
    const shot = {
      shotId: 'shot-1', shooterId: 'p2', facing: 'west', origin: { x: 13, y: 4 },
      path: [{ x: 12, y: 4 }, { x: 11, y: 4 }], victim: shared('p1', 11, 4),
    }
    const { result, sockets, commands } = setup({
      post: (_payload, actionType) => ({
        ok: true,
        body: { event: actionType === 'player.place'
          ? { ...worldEvent(3, { ...shared('p1', 11, 5), firstSpawn: false }), eventType: 'player.placed' }
          : { ...worldEvent(2, shared('p1', 11, 4)), eventType: 'player.shot', payload: { ...shot, shotId: 'self-shot', shooterId: 'p1', victim: null } },
        },
      }),
    })
    await ready(sockets, 0, 1)
    act(() => { result.current.fire(); result.current.fire() })
    await waitFor(() => expect(commands).toHaveLength(1))

    act(() => {
      sockets[0].message({ ...worldEvent(2, shared('p1', 11, 4)), eventType: 'player.shot', payload: shot })
    })
    expect(result.current.dead).toBe(true)
    expect(result.current.position).toBeNull()
    act(() => { result.current.move('south'); result.current.fire() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(commands).toHaveLength(1)

    act(() => result.current.rejoin())
    await waitFor(() => expect(commands).toHaveLength(2))
    await waitFor(() => expect(result.current.position).toMatchObject({ x: 11, y: 5, facing: 'south' }))
    expect(result.current.spawnReveals).toEqual([{ id: 'c3:3', playerId: 'p1', x: 11, y: 5 }])
  })

})

it('requires manual rejoining with the authoritative death revision after a refresh', async () => {
  const { result, sockets, commands } = setup({
    snapshots: [[]], eliminated: { p1: 1 }, deathAttribution: { p1: 'Robert <&>' },
    post: () => ({ ok: true, body: { event: { ...worldEvent(2, shared('p1', 11, 5, 2)), eventType: 'player.placed' } } }),
  })
  await ready(sockets, 0, 1)
  expect(result.current.dead).toBe(true)
  expect(result.current.attackerName).toBe('Robert <&>')
  act(() => { result.current.move('south'); result.current.fire() })
  expect(commands).toHaveLength(0)
  act(() => result.current.rejoin())
  await waitFor(() => expect(result.current.position).toMatchObject({ x: 11, y: 5 }))
  expect(commands[0]).toMatchObject({ expectedDeathRevision: 1 })
  expect(result.current.dead).toBe(false)
  expect(result.current.spawnReveals).toEqual([])
})


it('lets a defeated player whose saved avatar is taken choose another and rejoin with their death revision', async () => {
  const { result, sockets, commands } = setup({
    snapshots: [[]], eliminated: { p1: 1 },
    post: () => ({ ok: true, body: { event: { ...worldEvent(2, { ...shared('p1', 11, 5, 2), avatar: 'tide' }), eventType: 'player.placed' } } }),
  })
  await ready(sockets, 0, 1)
  expect(result.current.dead).toBe(true)
  await act(async () => { await result.current.chooseConflictAvatar('tide') })
  expect(commands[0]).toMatchObject({ expectedDeathRevision: 1, avatar: 'tide' })
  expect(result.current.dead).toBe(false)
  expect(result.current.position).toMatchObject({ x: 11, y: 5, avatar: 'tide' })
})

it('restores attribution when authentication completes after the snapshot', async () => {
  const { result, sockets, rerender, commands } = setup({ initialPlayer: null, snapshots: [[]], eliminated: { p1: 1 }, deathAttribution: { p1: 'Robert' } })
  await ready(sockets, 0, 1)
  expect(result.current.dead).toBe(false)
  rerender({ currentPlayer: player, currentWorld: 'world-01' })
  expect(result.current.dead).toBe(true)
  expect(result.current.attackerName).toBe('Robert')
  expect(commands).toHaveLength(0)
})

describe('movement response recovery', () => {
  it('unlocks on matching stream confirmation and ignores the old HTTP completion', async () => {
    let finish!: (value: { ok: boolean; body: unknown }) => void
    const { result, sockets, commands, fetchImpl } = setup({ post: () => new Promise((resolve) => { finish = resolve }) })
    await ready(sockets, 0, 1)
    act(() => result.current.move('east'))
    const oldFinish = finish
    const request = JSON.parse(String(vi.mocked(fetchImpl).mock.calls.at(-1)?.[1]?.body))
    act(() => sockets[0].message({ ...worldEvent(2, shared('p1', 12, 4, 2)), commandId: request.commandId }))
    act(() => result.current.move('east'))
    expect(commands).toHaveLength(2)
    await act(async () => oldFinish({ ok: true, body: { event: worldEvent(2, shared('p1', 12, 4, 2)) } }))
    act(() => result.current.move('east'))
    expect(commands).toHaveLength(2)
    expect(result.current.position?.x).toBe(12)
  })

  it('resynchronizes a hung move without replay and ignores its late response', async () => {
    let finish!: (value: { ok: boolean; body: unknown }) => void
    const { result, sockets, commands } = setup({
      snapshots: [[shared('p1', 11, 4)], [shared('p1', 12, 4, 2)]],
      post: () => new Promise((resolve) => { finish = resolve }),
    })
    await ready(sockets, 0, 1)
    vi.useFakeTimers()
    try {
      act(() => result.current.move('east'))
      const oldFinish = finish
      await act(async () => { await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS) })
      expect(result.current.state).toBe('syncing')
      expect(sockets).toHaveLength(2)
      act(() => result.current.move('east'))
      expect(commands).toHaveLength(1)
      act(() => sockets[1].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 2 }))
      act(() => result.current.move('east'))
      expect(commands).toHaveLength(2)
      await act(async () => oldFinish({ ok: true, body: { event: worldEvent(99, shared('p1', 30, 4, 99)) } }))
      expect(result.current.position?.x).toBe(12)
      act(() => result.current.move('east'))
      expect(commands).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('discards pending movement when the authenticated player changes', async () => {
    let finish!: (value: { ok: boolean; body: unknown }) => void
    const { result, sockets, rerender } = setup({ post: () => new Promise((resolve) => { finish = resolve }) })
    await ready(sockets, 0, 1)
    act(() => result.current.move('east'))
    rerender({ currentPlayer: { ...player, id: 'p2' }, currentWorld: 'world-01' })
    await act(async () => finish({ ok: true, body: { event: worldEvent(99, shared('p1', 30, 4, 99)) } }))
    expect(result.current.players.find((item) => item.playerId === 'p1')?.x).toBe(11)
    expect(result.current.position?.playerId).toBe('p2')
  })
})


it('resynchronizes after an ambiguous server error without replaying the move', async () => {
  const { result, sockets, commands } = setup({ post: () => ({ ok: false, body: {} }) })
  await ready(sockets, 0, 1)
  act(() => result.current.move('east'))
  await waitFor(() => expect(sockets).toHaveLength(2))
  expect(commands).toHaveLength(1)
  expect(result.current.state).toBe('syncing')
})

describe('movement pipelining', () => {
  it('keeps a single move in flight at normal cadence', async () => {
    const { result, sockets, commands } = setup({ post: () => new Promise(() => {}) })
    await ready(sockets, 0, 1)
    act(() => { result.current.move('east'); result.current.move('east') })
    await waitFor(() => expect(commands).toHaveLength(1))
  })

  it('pipelines up to the allowed moves in flight against predicted positions and revisions', async () => {
    const { result, sockets, commands } = setup({ post: () => new Promise(() => {}) })
    await ready(sockets, 0, 1)
    act(() => { result.current.move('east', 3); result.current.move('east', 3); result.current.move('south', 3); result.current.move('south', 3) })
    await waitFor(() => expect(commands).toHaveLength(3))
    expect(commands.map((c) => [c.expected, c.destination, c.expectedRevision])).toEqual([
      [{ x: 11, y: 4 }, { x: 12, y: 4 }, 1],
      [{ x: 12, y: 4 }, { x: 13, y: 4 }, 2],
      [{ x: 13, y: 4 }, { x: 13, y: 5 }, 3],
    ])
    // The authoritative position never moves ahead of confirmation; only the presentation prediction does.
    expect(result.current.position).toMatchObject({ x: 11, y: 4, positionRevision: 1 })
    expect(result.current.predictedPosition).toEqual({ x: 13, y: 5 })
  })

  it('clears the prediction once every pipelined move is confirmed', async () => {
    const { result, sockets } = setup({ post: (payload) => {
      const destination = payload.destination as { x: number; y: number }
      return { ok: true, body: { event: worldEvent(destination.x - 10, shared('p1', destination.x, 4, destination.x - 10)) } }
    } })
    await ready(sockets, 0, 1)
    act(() => { result.current.move('east', 2); result.current.move('east', 2) })
    expect(result.current.predictedPosition).toEqual({ x: 13, y: 4 })
    await waitFor(() => expect(result.current.position).toMatchObject({ x: 13, y: 4 }))
    expect(result.current.predictedPosition).toBeNull()
  })

  it('drops a rejected pipeline without a snapshot resync and resumes from the confirmed cell', async () => {
    const { result, sockets, commands } = setup({ post: (payload) => {
      const destination = payload.destination as { x: number; y: number }
      return destination.x === 12
        ? { ok: true, body: { event: worldEvent(2, shared('p1', 12, 4, 2)) } }
        : { ok: false, body: { error: { code: 'stale_position', message: 'Player position has advanced' } } }
    } })
    await ready(sockets, 0, 1)
    act(() => { result.current.move('east', 3); result.current.move('east', 3) })
    await waitFor(() => expect(result.current.position).toMatchObject({ x: 12, y: 4 }))
    await waitFor(() => expect(commands).toHaveLength(2))
    await waitFor(() => expect(result.current.predictedPosition).toBeNull())
    expect(sockets).toHaveLength(1)
    expect(result.current.message).toBeNull()
    act(() => result.current.move('east', 3))
    await waitFor(() => expect(commands).toHaveLength(3))
    expect(commands[2]).toMatchObject({ expected: { x: 12, y: 4 }, expectedRevision: 2 })
  })
})

describe('enemy mobs', () => {
  const mobAt = (mobId: string, x: number, y: number, health = 3, revision = 1) => ({ mobId, kind: 'basic', x, y, facing: 'south', health, maxHealth: 3, revision })
  const tick = (revision: number, payload: Record<string, unknown>) => ({
    ...worldEvent(revision, shared('p1', 11, 4)), eventType: 'mob.tick', commandId: `system-mob.tick-${revision}`,
    payload: { attackerName: 'a mob', spawned: [], attacks: [], ...payload },
  })

  it('hydrates the population from the snapshot, applies ordered ticks, and ignores stale deliveries', async () => {
    const { result, sockets } = setup({ state: { mobs: [mobAt('m1', 20, 4), mobAt('m2', 22, 4)] } })
    await ready(sockets, 0, 1)
    expect(result.current.mobs.map((mob) => mob.mobId)).toEqual(['m1', 'm2'])
    expect(result.current.mobDefeats).toEqual([])
    act(() => sockets[0].message(tick(2, { mobs: [mobAt('m1', 19, 4, 3, 2)] })))
    expect(result.current.mobs).toEqual([mobAt('m1', 19, 4, 3, 2)])
    act(() => sockets[0].message(tick(2, { mobs: [mobAt('m1', 20, 4), mobAt('m2', 22, 4)] })))
    expect(result.current.mobs).toEqual([mobAt('m1', 19, 4, 3, 2)])
    act(() => sockets[0].message(tick(3, { mobs: [mobAt('m1', 18, 4, 3, 3), mobAt('m3', 30, 6, 3, 3)], spawned: [mobAt('m3', 30, 6, 3, 3)] })))
    expect(result.current.mobs.map((mob) => [mob.mobId, mob.x])).toEqual([['m1', 18], ['m3', 30]])
  })

  it('applies arrow damage and removes a defeated mob once with a burst', async () => {
    const { result, sockets } = setup({ state: { mobs: [mobAt('m1', 13, 4)] } })
    await ready(sockets, 0, 1)
    const shot = (revision: number, hit: Record<string, unknown>) => ({
      ...worldEvent(revision, shared('p1', 11, 4)), eventType: 'player.shot', commandId: `shot-${revision}`, payload: {
        shotId: `shot-${revision}`, shooterId: 'p1', shooterName: 'Marlowe', facing: 'east', origin: { x: 11, y: 4 }, path: [{ x: 12, y: 4 }, { x: 13, y: 4 }],
        victim: null, victims: [], mobHits: [hit],
      },
    })
    act(() => sockets[0].message(shot(2, { ...mobAt('m1', 13, 4, 2, 2), defeated: false })))
    expect(result.current.mobs).toEqual([mobAt('m1', 13, 4, 2, 2)])
    expect(result.current.mobHitIds.m1).toBe(1)
    act(() => sockets[0].message(shot(3, { ...mobAt('m1', 13, 4, 0, 3), defeated: true })))
    expect(result.current.mobs).toEqual([])
    expect(result.current.mobDefeats).toEqual([{ id: 'shot-3:m1', mobId: 'm1', x: 13, y: 4 }])
    expect(result.current.dead).toBe(false)
    // A late duplicate of the earlier hit cannot resurrect the mob.
    act(() => sockets[0].message(shot(2, { ...mobAt('m1', 13, 4, 2, 2), defeated: false })))
    expect(result.current.mobs).toEqual([])
  })

  it('flashes a swing, then eliminates the local player with mob attribution and locks rejoin to that revision', async () => {
    const { result, sockets, commands } = setup({
      state: { mobs: [mobAt('m1', 12, 4)] },
      post: () => ({ ok: true, body: { event: { ...worldEvent(4, shared('p1', 11, 5, 4)), eventType: 'player.placed' } } }),
    })
    await ready(sockets, 0, 1)
    act(() => sockets[0].message(tick(2, { mobs: [{ ...mobAt('m1', 12, 4, 3, 2), facing: 'west' }] })))
    expect(result.current.dead).toBe(false)
    act(() => sockets[0].message(tick(3, {
      mobs: [{ ...mobAt('m1', 12, 4, 3, 3), facing: 'west' }], attacks: [{ mobId: 'm1', playerId: 'p1', outcome: 'eliminated' }],
      eliminatedVictims: [shared('p1', 11, 4)],
    })))
    expect(result.current.mobAttackIds.m1).toBe(1)
    expect(result.current.dead).toBe(true)
    expect(result.current.attackerName).toBe('a mob')
    expect(result.current.players.map((item) => item.playerId)).toEqual(['p2'])
    act(() => result.current.rejoin())
    await waitFor(() => expect(commands.some((command) => command.expectedDeathRevision === 3)).toBe(true))
    await waitFor(() => expect(result.current.position).toMatchObject({ x: 11, y: 5 }))
    expect(result.current.dead).toBe(false)
  })
})



describe('avatar changes across defeat', () => {
  it('saves without a position and retains defeat until an explicit rejoin', async () => {
    const { result, sockets, commands, actionTypes } = setup({
      snapshots: [[]], eliminated: { p1: 1 }, deathAttribution: { p1: 'Wren' },
      post: (_payload, action) => ({ ok: true, body: { event: {
        ...worldEvent(action === 'player.avatar' ? 2 : 3, { ...shared('p1', 11, 5, 3), avatar: 'dog' }),
        eventType: action === 'player.avatar' ? 'player.avatar_changed' : 'player.placed',
        ...(action === 'player.avatar' ? { payload: { playerId: 'p1', avatar: 'dog' } } : {}),
      } } }),
    })
    await ready(sockets, 0, 1)
    await act(async () => { expect(await result.current.changeAvatar('dog')).toMatchObject({ avatar: 'dog' }) })
    expect(actionTypes).toEqual(['player.avatar'])
    expect(commands[0]).toEqual({ avatar: 'dog' })
    expect(result.current.dead).toBe(true)
    expect(result.current.attackerName).toBe('Wren')
    expect(result.current.position).toBeNull()
    act(() => result.current.rejoin())
    await waitFor(() => expect(result.current.position?.avatar).toBe('dog'))
    expect(commands[1]).toMatchObject({ expectedDeathRevision: 1 })
  })

  it.each([2, 4])('does not restore a life when a pending save returns at revision %s after death', async (revision) => {
    let finish!: (value: { ok: boolean; body: unknown }) => void
    const { result, sockets } = setup({ post: () => new Promise((resolve) => { finish = resolve }) })
    await ready(sockets, 0, 1)
    let saving!: ReturnType<typeof result.current.changeAvatar>
    act(() => { saving = result.current.changeAvatar('dog') })
    act(() => sockets[0].message({ ...worldEvent(2, shared('p1', 11, 4)), eventType: 'test.noop', payload: {} }))
    act(() => sockets[0].message({ ...worldEvent(3, shared('p1', 11, 4)), eventType: 'mob.tick', payload: {
      eliminatedVictims: [shared('p1', 11, 4)], attackerName: 'Enemy',
    } }))
    expect(result.current.dead).toBe(true)
    await act(async () => {
      finish({ ok: true, body: { event: { ...worldEvent(revision, { ...shared('p1', 11, 4), avatar: 'dog' }), eventType: 'player.avatar_changed' } } })
      await saving
    })
    expect(result.current.position).toBeNull()
    expect(result.current.dead).toBe(true)
    expect(result.current.attackerName).toBe('Enemy')
  })

  it('preserves an earlier movement confirmation when the newer cosmetic response arrives first', async () => {
    const { result, sockets } = setup({ post: () => ({ ok: true, body: { event: {
      ...worldEvent(3, { ...shared('p1', 11, 5, 2), avatar: 'dog' }), eventType: 'player.avatar_changed',
    } } }) })
    await ready(sockets, 0, 1)
    await act(async () => { await result.current.changeAvatar('dog') })
    expect(result.current.position).toMatchObject({ x: 11, y: 4, avatar: 'dog' })
    act(() => sockets[0].message(worldEvent(2, shared('p1', 11, 5, 2))))
    expect(result.current.position).toMatchObject({ x: 11, y: 5, avatar: 'dog', positionRevision: 2 })
  })
})
