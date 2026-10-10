// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { MapCanvas } from './components/MapCanvas'
import { HOW_TO_PLAY_KEY, HOW_TO_PLAY_VERSION } from './howToPlay'
import { PLAYER_POSITION_STORAGE_VERSION } from './playerPosition'
import { saveSession, type StorageLike } from './session/storage'
import type { Player } from './session/types'

const player: Player = { id: 'p1', name: 'Marlowe', avatar: 'moss', customAvatar: null, createdAt: 1, lastSeenAt: 2 }
const storedPosition = (x: number, y: number) => JSON.stringify({ version: PLAYER_POSITION_STORAGE_VERSION, x, y })
let worldSockets: TestWebSocket[] = []

class TestWebSocket {
  listeners = new Map<string, ((event: Event | MessageEvent) => void)[]>()
  constructor() { worldSockets.push(this) }
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send() {}
  close() { this.listeners.get('close')?.forEach((listener) => listener(new Event('close'))) }
  message(value: object) {
    const event = new MessageEvent('message', { data: JSON.stringify(value) })
    this.listeners.get('message')?.forEach((listener) => listener(event))
  }
}

function memoryStorage(): StorageLike {
  // A returning device: the first-visit How to play panel would block gameplay input.
  const data = new Map<string, string>([[HOW_TO_PLAY_KEY, JSON.stringify({ version: HOW_TO_PLAY_VERSION, dismissed: true })]])
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

type Route = (init: RequestInit) => { status: number; body?: unknown }

function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ path: string; init: RequestInit }> = []
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, init })
    const route = routes[`${init.method ?? 'GET'} ${path}`]
    if (!route) return new Response(JSON.stringify({ error: 'not-found', message: 'nope' }), { status: 404 })
    const { status, body } = route(init)
    return new Response(body === undefined ? null : JSON.stringify(body), { status })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

beforeEach(() => {
  localStorage.setItem(HOW_TO_PLAY_KEY, JSON.stringify({ version: HOW_TO_PLAY_VERSION, dismissed: true }))
  // MapCanvas relies on ResizeObserver and canvas 2D contexts, neither of which jsdom provides.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  HTMLCanvasElement.prototype.getContext = (() => null) as never
  worldSockets = []
  vi.stubGlobal('WebSocket', TestWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
})

const healthOnly = {
  'GET /healthz': () => ({ status: 200, body: { status: 'ok', service: 's', version: 'v' } }),
  'GET /v1/worlds/world-01/snapshot': () => ({
    status: 200,
    body: {
      protocolVersion: 1, schemaVersion: 2, worldId: 'world-01', revision: 1,
      state: { players: [{ playerId: player.id, name: player.name, avatar: player.avatar, x: 11, y: 4, positionRevision: 1, facing: 'south' }] },
    },
  }),
}

it('shows no scores, leaderboards, or stats even when a legacy snapshot carries combat records', async () => {
  const records = [{ playerId: 'offline', name: 'Archer', kills: 8, deaths: 2, currentStreak: 3, grenades: 3, grenadeRefillEarned: false }]
  const { impl } = fakeFetch({
    ...healthOnly,
    'GET /v1/worlds/world-01/snapshot': () => ({ status: 200, body: {
      ...healthOnly['GET /v1/worlds/world-01/snapshot']().body,
      state: { ...healthOnly['GET /v1/worlds/world-01/snapshot']().body.state, combatRecords: records },
    } }),
  })
  const { container } = render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl: impl }} />)
  await waitFor(() => expect(worldSockets).toHaveLength(1))
  worldSockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
  await screen.findByText('Synced · r1')
  expect(screen.queryByText('Combat leaders')).toBeNull()
  expect(screen.queryByText('Archer')).toBeNull()
  expect(container.querySelector('.own-combat-record')).toBeNull()
  expect(container.querySelector('.player-marker-score')).toBeNull()
})

describe('auth modal', () => {
  it('shows the modal over the map when no session is stored', () => {
    render(<App storage={memoryStorage()} fetchImpl={fakeFetch(healthOnly).impl} />)
    expect(screen.getByRole('dialog', { name: 'Join Party Conquest' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Party Conquest world map' })).toBeTruthy()
  })

  it('blocks submission until name, pin, and avatar are valid, associating errors with controls', async () => {
    const user = userEvent.setup()
    const { impl, calls } = fakeFetch(healthOnly)
    render(<App storage={memoryStorage()} fetchImpl={impl} />)

    await user.click(screen.getByRole('button', { name: 'Create and enter' }))
    const name = screen.getByRole('textbox', { name: 'Name' })
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(name.getAttribute('aria-describedby')).toBe(screen.getByText('Enter a name to continue.').id)
    expect(screen.getByText('Enter a 4-digit PIN.')).toBeTruthy()
    expect(screen.getByText('Choose an avatar to continue.')).toBeTruthy()
    expect(calls.filter((c) => c.path.startsWith('/players'))).toHaveLength(0)
  })

  it('registers, stores the token, and dismisses the modal', async () => {
    const user = userEvent.setup()
    const storage = memoryStorage()
    const { impl, calls } = fakeFetch({
      ...healthOnly,
      'POST /players/register': () => ({ status: 201, body: { token: 'tok-1', player } }),
    })
    render(<App storage={storage} fetchImpl={impl} />)

    await user.type(screen.getByRole('textbox', { name: 'Name' }), '  Marlowe ')
    await user.type(screen.getByLabelText('4-digit PIN'), '12x34')
    await user.click(screen.getByRole('radio', { name: 'Moss leaf' }))
    await user.click(screen.getByRole('button', { name: 'Create and enter' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const register = calls.find((c) => c.path === '/players/register')!
    expect(JSON.parse(register.init.body as string)).toEqual({ name: 'Marlowe', pin: '1234', avatar: 'moss' })
    expect(storage.getItem('party-conquest.session')).toContain('tok-1')
  })

  it('shows a name error when the backend reports the name is taken', async () => {
    const user = userEvent.setup()
    const { impl } = fakeFetch({
      ...healthOnly,
      'POST /players/register': () => ({ status: 409, body: { error: 'name-taken', message: 'That name is already taken.' } }),
    })
    render(<App storage={memoryStorage()} fetchImpl={impl} />)

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Marlowe')
    await user.type(screen.getByLabelText('4-digit PIN'), '1234')
    await user.click(screen.getByRole('radio', { name: 'Moss leaf' }))
    await user.click(screen.getByRole('button', { name: 'Create and enter' }))

    expect(await screen.findByText('That name is already taken.')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Marlowe')
    expect((screen.getByRole('radio', { name: 'Moss leaf' }) as HTMLInputElement).checked).toBe(true)
  })

  it('signs a returning player in without an avatar and reports bad credentials', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const { impl } = fakeFetch({
      ...healthOnly,
      'POST /players/login': () =>
        ++attempts === 1
          ? { status: 401, body: { error: 'invalid-credentials', message: "That name and PIN don't match." } }
          : { status: 200, body: { token: 'tok-2', player } },
    })
    render(<App storage={memoryStorage()} fetchImpl={impl} />)

    await user.click(screen.getByRole('tab', { name: 'Returning player' }))
    expect(screen.queryByRole('radio')).toBeNull()
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Marlowe')
    await user.type(screen.getByLabelText('4-digit PIN'), '9999')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText("That name and PIN don't match.")).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('restores a stored token through the backend and skips the modal', async () => {
    const storage = memoryStorage()
    saveSession({ token: 'tok-1', player }, storage)
    const { impl, calls } = fakeFetch({ ...healthOnly, 'GET /players/me': () => ({ status: 200, body: { player } }) })
    render(<App storage={storage} fetchImpl={impl} />)

    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(calls.some((c) => c.path === '/players/me')).toBe(true))
    const me = calls.find((c) => c.path === '/players/me')!
    expect((me.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('refreshes the stored player after an authoritative avatar change', async () => {
    const user = userEvent.setup()
    const storage = memoryStorage()
    saveSession({ token: 'tok-1', player }, storage)
    const updated = { ...player, avatar: 'shark' as const }
    const changedPosition = { playerId: player.id, name: player.name, avatar: updated.avatar, x: 11, y: 4, positionRevision: 1, facing: 'south' }
    const { impl } = fakeFetch({
      ...healthOnly,
      'GET /players/me': () => ({ status: 200, body: { player } }),
      'POST /v1/worlds/world-01/commands': () => ({ status: 201, body: { event: {
        protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2,
        eventType: 'player.avatar_changed', commandId: 'avatar', payload: changedPosition, committedAt: '',
      } } }),
    })
    render(<App storage={storage} fetchImpl={impl} />)
    await waitFor(() => expect(worldSockets).toHaveLength(1))
    worldSockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await user.click(await screen.findByRole('button', { name: 'Change avatar' }))
    await user.click(screen.getByRole('radio', { name: 'Pixel shark' }))
    await user.click(screen.getByRole('button', { name: 'Save avatar' }))
    await waitFor(() => expect(storage.getItem('party-conquest.session')).toContain('"avatar":"shark"'))
    expect(screen.queryByRole('dialog', { name: 'Change avatar' })).toBeNull()
  })

  it('clears a rejected token and shows the modal', async () => {
    const storage = memoryStorage()
    saveSession({ token: 'stale', player }, storage)
    const { impl } = fakeFetch({ ...healthOnly, 'GET /players/me': () => ({ status: 401, body: { error: 'unauthorized', message: 'x' } }) })
    render(<App storage={storage} fetchImpl={impl} />)

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(storage.getItem('party-conquest.session')).toBeNull()
  })

  it('keeps the stored player when the backend is unreachable', async () => {
    const storage = memoryStorage()
    saveSession({ token: 'tok-1', player }, storage)
    const impl = vi.fn(async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    render(<App storage={storage} fetchImpl={impl} />)

    await waitFor(() => expect(impl).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(storage.getItem('party-conquest.session')).toContain('tok-1')
  })

  it('shows a form error when the backend cannot be reached during sign-in', async () => {
    const user = userEvent.setup()
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/healthz')) return new Response('{}', { status: 200 })
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    render(<App storage={memoryStorage()} fetchImpl={impl} />)

    await user.click(screen.getByRole('tab', { name: 'Returning player' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Marlowe')
    await user.type(screen.getByLabelText('4-digit PIN'), '1234')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('blocking connection screen', () => {
  it('covers the map during initial synchronization and unavailable recovery', async () => {
    render(<MapCanvas player={null} token={null} syncDeps={{ storage: memoryStorage(), fetchImpl: fakeFetch(healthOnly).impl,
      minBackoffMs: 10_000, maxBackoffMs: 10_000 }} />)

    expect(screen.getByRole('status').textContent).toContain('Loading the shared world')
    expect((screen.getByRole('button', { name: 'Zoom in', hidden: true }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(worldSockets).toHaveLength(1))
    worldSockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByText('Synced · r1')

    worldSockets[0].close()
    expect(await screen.findByText('Shared world unavailable')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Zoom in', hidden: true }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('covers the map while reconnecting', async () => {
    render(<MapCanvas player={null} token={null} syncDeps={{ storage: memoryStorage(), fetchImpl: fakeFetch(healthOnly).impl,
      minBackoffMs: 10_000, maxBackoffMs: 20_000 }} />)
    await waitFor(() => expect(worldSockets).toHaveLength(1))
    worldSockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByText('Synced · r1')

    worldSockets[0].close()
    expect(await screen.findByText('Reconnecting to the shared world')).toBeTruthy()
  })

  it('cancels an active gesture and ignores its remaining input after disconnect', async () => {
    render(<MapCanvas player={null} token={null} syncDeps={{ storage: memoryStorage(), fetchImpl: fakeFetch(healthOnly).impl,
      minBackoffMs: 10_000, maxBackoffMs: 20_000 }} />)
    await waitFor(() => expect(worldSockets).toHaveLength(1))
    worldSockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByText('Synced · r1')

    const canvas = screen.getByLabelText(/Interactive 80 by 80 block world/)
    const captured = new Set<number>()
    canvas.setPointerCapture = vi.fn((pointerId) => void captured.add(pointerId))
    canvas.hasPointerCapture = vi.fn((pointerId) => captured.has(pointerId))
    canvas.releasePointerCapture = vi.fn((pointerId) => void captured.delete(pointerId))
    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: 'touch', clientX: 20, clientY: 10 })
    expect(canvas.classList.contains('is-panning')).toBe(true)

    worldSockets[0].close()
    await screen.findByText('Reconnecting to the shared world')
    // Capture release runs in the disconnect effect, which can commit after the overlay text renders.
    await waitFor(() => expect(captured.size).toBe(0))
    await waitFor(() => expect(canvas.classList.contains('is-panning')).toBe(false))

    fireEvent.pointerMove(canvas, { pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 10 })
    fireEvent.mouseEnter(canvas)
    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    expect(screen.getByLabelText('Current zoom 100%')).toBeTruthy()
    expect(canvas.classList.contains('space-ready')).toBe(false)
  })
})

describe('local player movement', () => {
  it('creates and clears a development-only mock player without the backend', async () => {
    const user = userEvent.setup()
    render(<App storage={memoryStorage()} fetchImpl={fakeFetch(healthOnly).impl} />)

    await user.click(screen.getByRole('button', { name: /Dev tools/ }))
    const panel = screen.getByText('Local preview identity').closest('form')!
    await user.clear(within(panel).getByLabelText('Name'))
    await user.type(within(panel).getByLabelText('Name'), 'Map Tester')
    await user.selectOptions(within(panel).getByLabelText('Avatar'), 'tide')
    await user.click(within(panel).getByRole('button', { name: 'Mock new player' }))
    expect(within(panel).queryByRole('button', { name: /Shield|gold/ })).toBeNull()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText(/Map Tester at column/)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText(/Interactive 80 by 80 block world/))
    await user.click(within(panel).getByRole('button', { name: 'Clear mock' }))
    expect(await screen.findByRole('dialog', { name: 'Join Party Conquest' })).toBeTruthy()
  })

  it('does not create or move a player until session restoration resolves', async () => {
    const storage = memoryStorage()
    saveSession({ token: 'tok-1', player }, storage)
    storage.setItem('party-conquest.position.p1', storedPosition(11, 4))
    let resolvePlayer!: (response: Response) => void
    const impl = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/players/me') return new Promise<Response>((resolve) => { resolvePlayer = resolve })
      if (path === '/v1/worlds/world-01/snapshot') return Promise.resolve(new Response(JSON.stringify(healthOnly['GET /v1/worlds/world-01/snapshot']().body), { status: 200 }))
      return Promise.resolve(new Response('{}', { status: 503 }))
    }) as unknown as typeof fetch

    render(<App storage={storage} fetchImpl={impl} />)
    expect(screen.queryByText(/Marlowe at column/)).toBeNull()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(storage.getItem('party-conquest.position.p1')).toBe(storedPosition(11, 4))

    resolvePlayer(new Response(JSON.stringify({ player }), { status: 200 }))
    expect(await screen.findByText('Marlowe at column 12, row 5')).toBeTruthy()
  })

  it('moves once per fresh connected keydown and ignores repeats, modifiers, and editing controls', async () => {
    const storage = memoryStorage()
    saveSession({ token: 'tok-1', player }, storage)
    storage.setItem('party-conquest.position.p1', storedPosition(11, 4))
    const { impl } = fakeFetch({
      ...healthOnly,
      'GET /players/me': () => ({ status: 200, body: { player } }),
      'POST /v1/worlds/world-01/commands': (init) => {
        const command = JSON.parse(String(init.body))
        const destination = command.payload.destination
        return { status: 201, body: { event: {
          protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2,
          eventType: 'player.moved', commandId: command.commandId, committedAt: '',
          payload: { playerId: player.id, name: player.name, avatar: player.avatar, ...destination, positionRevision: 2, facing: 'south' },
        } } }
      },
    })
    render(<App storage={storage} fetchImpl={impl} />)
    await screen.findByText('Marlowe at column 12, row 5')
    await waitFor(() => expect(worldSockets).toHaveLength(1))
    worldSockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByText('Synced · r1')

    fireEvent.keyDown(window, { key: 'ArrowRight', repeat: true })
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    const input = document.createElement('input')
    document.body.append(input)
    fireEvent.keyDown(input, { key: 'd' })
    expect(storage.getItem('party-conquest.position.p1')).toBe(storedPosition(11, 4))

    fireEvent.keyDown(window, { key: 'd' })
    expect(await screen.findByText('Marlowe at column 13, row 5')).toBeTruthy()
    expect(storage.getItem('party-conquest.position.p1')).toBe(storedPosition(11, 4))
    input.remove()
  })

  it('repeats held movement at 80ms, prioritizes the latest key, and stops on release or blur', async () => {
    let revision = 1
    const { impl, calls } = fakeFetch({
      ...healthOnly,
      'GET /players/me': () => ({ status: 200, body: { player } }),
      'POST /v1/worlds/world-01/commands': (init) => {
        const command = JSON.parse(String(init.body))
        revision += 1
        if (command.actionType === 'player.shoot') return { status: 201, body: { event: {
          protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision,
          eventType: 'player.shot', commandId: command.commandId, committedAt: '',
          payload: { shotId: command.commandId, shooterId: player.id, facing: 'east', origin: { x: 13, y: 4 }, path: [], victim: null },
        } } }
        const { expected, destination } = command.payload
        const facing = destination.x > expected.x ? 'east' : destination.x < expected.x ? 'west' : destination.y > expected.y ? 'south' : 'north'
        return { status: 201, body: { event: {
          protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision,
          eventType: 'player.moved', commandId: command.commandId, committedAt: '',
          payload: { playerId: player.id, name: player.name, avatar: player.avatar, ...destination, positionRevision: revision, facing },
        } } }
      },
    })
    // Keep auth stable: App restoration can replace the first public socket
    // after this test delivers ready, leaving movement waiting on a new socket.
    render(<MapCanvas player={player} token="tok-1" syncDeps={{ fetchImpl: impl }} />)
    await waitFor(() => expect(worldSockets).toHaveLength(1))
    worldSockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByText('Synced · r1')
    vi.useFakeTimers()

    const movementCommands = () => calls.filter((call) => call.init.method === 'POST').map((call) => JSON.parse(String(call.init.body)))
    fireEvent.keyDown(window, { key: 'd' })
    await act(async () => {})
    expect(movementCommands()).toHaveLength(1)

    act(() => vi.advanceTimersByTime(79))
    expect(movementCommands()).toHaveLength(1)
    fireEvent.keyDown(window, { key: 'd', repeat: true })
    act(() => vi.advanceTimersByTime(1))
    await act(async () => {})
    await vi.waitFor(() => expect(movementCommands()).toHaveLength(2))

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(movementCommands()).toHaveLength(2)
    fireEvent.keyDown(window, { key: 'a' })
    await act(async () => {})
    expect(movementCommands().at(-1).payload.destination.x).toBe(12)

    fireEvent.keyUp(window, { key: 'a' })
    act(() => vi.advanceTimersByTime(80))
    await act(async () => {})
    expect(movementCommands().at(-1).payload.destination.x).toBe(13)

    window.dispatchEvent(new Event('blur'))
    act(() => vi.advanceTimersByTime(1_000))
    expect(movementCommands()).toHaveLength(4)

    fireEvent.keyUp(window, { key: 'd' })
    fireEvent.keyUp(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'd' })
    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    fireEvent.keyDown(window, { code: 'Space', key: ' ', repeat: true })
    await act(async () => {})
    const shots = () => movementCommands().filter((command) => command.actionType === 'player.shoot')
    expect(shots()).toHaveLength(1)
    act(() => vi.advanceTimersByTime(80))
    await act(async () => {})
    expect(movementCommands().filter((command) => command.actionType === 'player.move')).toHaveLength(6)
    expect(shots()).toHaveLength(1)
    fireEvent.keyUp(window, { key: 'd' })
    vi.useRealTimers()
  })
})

it('offers no self-destruct control and ignores the retired X shortcut', async () => {
  const { impl, calls } = fakeFetch(healthOnly)
  render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl: impl }} />)
  await waitFor(() => expect(worldSockets).toHaveLength(1))
  worldSockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
  await screen.findByText('Synced · r1')
  expect(screen.queryByRole('button', { name: /Self-destruct/ })).toBeNull()
  fireEvent.keyDown(window, { key: 'x', code: 'KeyX' })
  await act(async () => {})
  expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(0)
})

it('defeats the local player with one arrow and offers Rejoin immediately', async () => {
  render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl: fakeFetch(healthOnly).impl }} />)
  await waitFor(() => expect(worldSockets).toHaveLength(1))
  worldSockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
  await screen.findByText('Synced · r1')
  await act(async () => {
    worldSockets[0].message({
      protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2,
      eventType: 'player.shot', commandId: 'arrow-death', committedAt: '', payload: {
        shotId: 'arrow-death', shooterId: 'p3', shooterName: 'Wren', facing: 'west', origin: { x: 13, y: 4 }, path: [{ x: 12, y: 4 }, { x: 11, y: 4 }],
        victim: { playerId: 'p1', name: 'Marlowe', avatar: 'moss', x: 11, y: 4, positionRevision: 1, facing: 'south', deathRevision: 2 },
      },
    })
  })

  expect(screen.getByRole('dialog', { name: 'You were defeated' })).toBeTruthy()
  expect(screen.getByText('Ready for another life?')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Rejoin world' }) as HTMLButtonElement).disabled).toBe(false)
})
