// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Player } from '../session/types'
import { movementBlockCenter, WORLD } from '../terrain'
import { drawMap, grassColor } from '../mapRenderer'
import { MIN_STEP_DURATION_MS } from '../markerMotion'
import { constrainCamera, fitWorld, panBy, worldToScreen, type Camera, type Point } from '../viewport'
import { HOW_TO_PLAY_KEY, HOW_TO_PLAY_VERSION } from '../howToPlay'
import { MapCanvas } from './MapCanvas'
import { laserLane, laserStop } from '../laser'

// Counts static-map paints; jsdom has no 2D context, so the real painter would draw nothing anyway.
vi.mock('../mapRenderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mapRenderer')>()),
  drawMap: vi.fn(() => true),
}))

vi.mock('../avatarImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../avatarImage')>()),
  loadAvatarImage: vi.fn(async () => ({ source: {} as CanvasImageSource, width: 400, height: 300, url: 'blob:upload', release: vi.fn() })),
  renderAvatarCrop: vi.fn(async () => ({ contentType: 'image/webp', data: 'UklGRg==', previewUrl: 'data:image/webp;base64,UklGRg==' })),
}))

const player: Player = { id: 'p1', name: 'Marlowe', avatar: 'moss', customAvatar: null, createdAt: 1, lastSeenAt: 2 }
let sockets: TestWebSocket[] = []

class TestWebSocket {
  listeners = new Map<string, ((event: Event | MessageEvent) => void)[]>()
  sent: string[] = []
  constructor() { sockets.push(this) }
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(value: string) { this.sent.push(value) }
  close() { this.listeners.get('close')?.forEach((listener) => listener(new Event('close'))) }
  message(value: object) {
    const event = new MessageEvent('message', { data: JSON.stringify(value) })
    this.listeners.get('message')?.forEach((listener) => listener(event))
  }
}

const snapshot = {
  protocolVersion: 1, schemaVersion: 2, worldId: 'world-01', revision: 1,
  state: { players: [{ playerId: player.id, name: player.name, avatar: player.avatar, x: 11, y: 4, positionRevision: 1, facing: 'south' }] },
}

function fakeFetch(post?: () => Promise<Response>, state: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/worlds/world-01/snapshot') return new Response(JSON.stringify({ ...snapshot, state: { ...snapshot.state, ...state } }), { status: 200 })
    if (path === '/v1/worlds/world-01/commands' && init.method === 'POST' && post) return post()
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

/** Serves the world's avatar availability ahead of `fetchImpl`. */
function withAvatarsInUse(fetchImpl: typeof fetch, inUse: { avatar: string; playerId: string }[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => new URL(String(input)).pathname === '/v1/worlds/world-01/avatars'
    ? new Response(JSON.stringify({ worldId: 'world-01', inUse }), { status: 200 })
    : fetchImpl(input, init)) as unknown as typeof fetch
}

const avatarChanged = (avatar: string, commandId = 'change') => async () => new Response(JSON.stringify({ event: {
  protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2, eventType: 'player.avatar_changed', commandId,
  payload: { ...snapshot.state.players[0], avatar }, committedAt: '',
} }), { status: 201 })

async function renderConnected(fetchImpl = fakeFetch()) {
  render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl }} />)
  await waitFor(() => expect(sockets).toHaveLength(1))
  sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
  await screen.findByText('Synced · r1')
}

describe('in-game avatar changing', () => {
  it('preselects the current avatar and cancels without a command', async () => {
    const user = userEvent.setup()
    const fetchImpl = fakeFetch()
    await renderConnected(fetchImpl)
    await user.click(screen.getByRole('button', { name: 'Change avatar' }))
    expect(screen.getAllByRole('radio')).toHaveLength(32)
    expect((screen.getByRole('radio', { name: 'Moss leaf' }) as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Change avatar' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Change avatar' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Change avatar' })).toBeNull()
    expect(vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it('disables avatars other connected players hold and keeps the grid in its own scroll area', async () => {
    const user = userEvent.setup()
    await renderConnected(withAvatarsInUse(fakeFetch(), [{ avatar: 'shark', playerId: 'p2' }, { avatar: 'moss', playerId: 'p1' }]))
    await user.click(screen.getByRole('button', { name: 'Change avatar' }))
    const dialog = screen.getByRole('dialog', { name: 'Change avatar' })
    await waitFor(() => expect((screen.getByRole('radio', { name: /shark/i }) as HTMLInputElement).disabled).toBe(true))
    expect(screen.getByRole('radio', { name: /shark/i }).closest('label')?.textContent).toContain('In use')
    expect((screen.getByRole('radio', { name: 'Moss leaf' }) as HTMLInputElement).disabled).toBe(false)
    expect(dialog.querySelector('.avatar-grid-scroll .avatar-grid')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save avatar' })).toBeTruthy()
  })

  it('makes a player whose saved avatar is taken choose another before continuing', async () => {
    const user = userEvent.setup()
    const onPlayerChange = vi.fn()
    const fetchImpl = withAvatarsInUse(fakeFetch(avatarChanged('shark')), [{ avatar: 'moss', playerId: 'p2' }])
    render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl }} onPlayerChange={onPlayerChange} />)
    await waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByText('Synced · r1')
    act(() => sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'avatarStatus', worldId: 'world-01', available: false, avatar: 'moss' }))
    const dialog = await screen.findByRole('dialog', { name: 'Choose another avatar' })
    expect(dialog.textContent).toContain('Another player in this world is using your saved avatar')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Choose another avatar' })).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('radio', { name: /Moss leaf/ }) as HTMLInputElement).disabled).toBe(true))
    expect((screen.getByRole('button', { name: 'Save avatar' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('radio', { name: /shark/i }))
    await user.click(screen.getByRole('button', { name: 'Save avatar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const posts = vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({ actionType: 'player.avatar', payload: { avatar: 'shark' } })
    expect(onPlayerChange).toHaveBeenCalledWith({ ...player, avatar: 'shark' })
  })

  it('keeps a returning player off the map until they pick a free avatar, then places them with it', async () => {
    const user = userEvent.setup()
    const placements: unknown[] = []
    const post = vi.fn(async () => {
      if (!placements.length) {
        placements.push(null)
        return new Response(JSON.stringify({ error: { code: 'avatar_in_use', message: 'Another player is using that avatar right now. Choose a different one.' } }), { status: 409 })
      }
      return new Response(JSON.stringify({ event: {
        protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2, eventType: 'player.placed', commandId: 'place',
        payload: { ...snapshot.state.players[0], avatar: 'clown' }, committedAt: '',
      } }), { status: 201 })
    })
    const fetchImpl = withAvatarsInUse(fakeFetch(post, { players: [] }), [{ avatar: 'moss', playerId: 'p2' }])
    render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl }} />)
    await waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByRole('dialog', { name: 'Choose another avatar' })
    await user.click(screen.getByRole('radio', { name: /clown/i }))
    await user.click(screen.getByRole('button', { name: 'Save avatar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const bodies = vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies.map((body) => body.actionType)).toEqual(['player.place', 'player.place'])
    expect(bodies[0].payload.avatar).toBeUndefined()
    expect(bodies[1].payload).toMatchObject({ avatar: 'clown' })
  })

  it('uploads and equips a cropped image from the in-game picker', async () => {
    const user = userEvent.setup()
    const custom = `custom-${'1'.repeat(32)}-0000abcd`
    const onPlayerChange = vi.fn()
    const base = fakeFetch(avatarChanged(custom))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => new URL(String(input)).pathname === '/players/me/custom-avatar'
      ? new Response(JSON.stringify({ player: { ...player, customAvatar: custom } }), { status: 200 })
      : base(input, init)) as unknown as typeof fetch
    render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl }} onPlayerChange={onPlayerChange} />)
    await waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByText('Synced · r1')
    await user.click(screen.getByRole('button', { name: 'Change avatar' }))
    fireEvent.change(screen.getByLabelText('Upload your own image'), { target: { files: [new File(['gif'], 'a.gif', { type: 'image/gif' })] } })
    expect((await screen.findByRole('alert')).textContent).toBe('Choose a PNG, JPEG, or WebP image.')
    fireEvent.change(screen.getByLabelText('Upload your own image'), { target: { files: [new File(['png'], 'a.png', { type: 'image/png' })] } })
    await screen.findByRole('group', { name: 'Crop your image to a square' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('slider', { name: 'Zoom' })))
    await user.click(screen.getByRole('button', { name: 'Use image' }))
    await waitFor(() => expect((screen.getByRole('radio', { name: 'Uploaded image' }) as HTMLInputElement).checked).toBe(true))
    const put = vi.mocked(fetchImpl).mock.calls.find(([, init]) => init?.method === 'PUT')!
    expect(JSON.parse(String(put[1]?.body))).toEqual({ contentType: 'image/webp', data: 'UklGRg==' })
    expect(onPlayerChange).toHaveBeenCalledWith({ ...player, customAvatar: custom })
    await user.click(screen.getByRole('button', { name: 'Save avatar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const posts = vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({ actionType: 'player.avatar', payload: { avatar: custom } })
  })

  it('blocks gameplay input, prevents duplicate saves, and applies one successful update', async () => {
    const user = userEvent.setup()
    let finish!: (response: Response) => void
    const changed = { ...snapshot.state.players[0], avatar: 'shark' }
    const fetchImpl = fakeFetch(() => new Promise((resolve) => { finish = resolve }))
    const onPlayerChange = vi.fn()
    render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl }} onPlayerChange={onPlayerChange} />)
    await waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await user.click(await screen.findByRole('button', { name: 'Change avatar' }))
    fireEvent.keyDown(window, { key: 'w' })
    fireEvent.keyDown(window, { code: 'Space' })
    await user.click(screen.getByRole('radio', { name: 'Pixel shark' }))
    await user.dblClick(screen.getByRole('button', { name: 'Save avatar' }))
    expect(vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    finish(new Response(JSON.stringify({ event: {
      protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2,
      eventType: 'player.avatar_changed', commandId: 'avatar', payload: changed, committedAt: '',
    } }), { status: 201 }))
    await waitFor(() => expect(onPlayerChange).toHaveBeenCalledWith({ ...player, avatar: 'shark' }))
    expect(screen.queryByRole('dialog', { name: 'Change avatar' })).toBeNull()
  })

  it('saves an open avatar selection after death and keeps the defeat screen', async () => {
    const user = userEvent.setup()
    const onPlayerChange = vi.fn()
    const fetchImpl = fakeFetch(async () => new Response(JSON.stringify({ event: {
      protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 3,
      eventType: 'player.avatar_changed', commandId: 'avatar', payload: { playerId: player.id, avatar: 'shark' }, committedAt: '',
    } }), { status: 201 }))
    render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl }} onPlayerChange={onPlayerChange} />)
    await waitFor(() => expect(sockets).toHaveLength(1))
    act(() => sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 }))
    await user.click(await screen.findByRole('button', { name: 'Change avatar' }))
    await user.click(screen.getByRole('radio', { name: 'Pixel shark' }))
    act(() => sockets[0].message({
      protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2,
      eventType: 'mob.tick', commandId: 'death', committedAt: '',
      payload: { eliminatedVictims: snapshot.state.players, attackerName: 'Enemy' },
    }))
    expect(screen.getByRole('dialog', { name: 'Change avatar' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save avatar' }))
    await waitFor(() => expect(onPlayerChange).toHaveBeenCalledWith({ ...player, avatar: 'shark' }))
    expect(screen.queryByRole('dialog', { name: 'Change avatar' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'You were defeated' })).toBeTruthy()
    expect(screen.queryByTestId('player-p1')).toBeNull()
    expect(vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('keeps the pending choice open after a recoverable failure', async () => {
    const user = userEvent.setup()
    const fetchImpl = fakeFetch(async () => new Response(JSON.stringify({
      error: { code: 'storage_unavailable', message: 'Could not save that avatar. Try again.' },
    }), { status: 503 }))
    await renderConnected(fetchImpl)
    await user.click(screen.getByRole('button', { name: 'Change avatar' }))
    await user.click(screen.getByRole('radio', { name: 'Tall cowboy hat' }))
    await user.click(screen.getByRole('button', { name: 'Save avatar' }))
    expect(await screen.findByText('Could not save that avatar. Try again.')).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'Tall cowboy hat' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('dialog', { name: 'Change avatar' })).toBeTruthy()
  })
})

beforeEach(() => {
  // A returning device: the first-visit How to play panel would block gameplay input.
  localStorage.setItem(HOW_TO_PLAY_KEY, JSON.stringify({ version: HOW_TO_PLAY_VERSION, dismissed: true }))
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {}; unobserve() {} })
  HTMLCanvasElement.prototype.getContext = (() => null) as never
  sockets = []
  vi.stubGlobal('WebSocket', TestWebSocket)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('hides navigation behind the syncing screen and offers no audio controls now that the game has no sound', () => {
  render(<MapCanvas player={null} token={null} syncDeps={{ fetchImpl: fakeFetch() }} />)

  const navigation = document.querySelector('.map-controls') as HTMLElement
  expect(navigation.getAttribute('aria-hidden')).toBe('true')
  expect(screen.queryByRole('group', { name: 'Master audio controls' })).toBeNull()
  expect(screen.queryByRole('button', { name: /mute/i })).toBeNull()
})

it('keeps the bottom-right player actions to Change avatar', async () => {
  await renderConnected()
  sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'powerUpStatus', storedPowerUp: 'speed', speedRemainingMs: 0 })
  const group = screen.getByRole('group', { name: 'Player actions' })
  expect(group.children).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Change avatar' }).parentElement).toBe(group)
  for (const name of [/speed/i, /grenade/i, /web/i, /self-destruct/i, /shop/i, /special/i, /stealth/i]) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }
})

describe('retired stealth (Issue #110)', () => {
  const posted = (fetchImpl: typeof fetch) => vi.mocked(fetchImpl).mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as { actionType: string })
  const me = snapshot.state.players[0]
  const marker = () => document.querySelector('.player-marker:not(.player-marker--remote)')!
  const expectNoStealth = () => {
    expect(screen.queryByRole('button', { name: /stealth/i })).toBeNull()
    expect(marker().className).toBe('player-marker')
    expect(marker().hasAttribute('data-stealth')).toBe(false)
    expect(document.querySelector('.stealth-badge, .stealth-control')).toBeNull()
    expect(document.body.textContent).not.toMatch(/stealth|hidden from enemies|an enemy can see you/i)
  }

  it('offers no control or shortcut, and a legacy stealthed snapshot shows a normal avatar', async () => {
    const fetchImpl = fakeFetch(undefined, { players: [{ ...me, stealth: true, stealthDetected: true }] })
    await renderConnected(fetchImpl)
    expectNoStealth()
    const keydown = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(keydown) })
    await act(async () => {})
    expect(keydown.defaultPrevented).toBe(false)
    expect(posted(fetchImpl).filter((command) => command.actionType === 'player.stealth')).toEqual([])
  })

  it('has no stealth control in touch mode', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('pointer: coarse'), addEventListener() {}, removeEventListener() {} })))
    await renderConnected()
    expect(screen.getByRole('group', { name: 'Touch controls' })).toBeTruthy()
    expectNoStealth()
  })
})

describe('Space rejoin shortcut', () => {
  const commands = (fetchImpl: typeof fetch) => vi.mocked(fetchImpl).mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)).actionType as string)
  const space = (target: EventTarget = window, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true, ...init })
    act(() => { target.dispatchEvent(event) })
    return event
  }

  async function defeat() {
    const fetchImpl = fakeFetch(() => new Promise(() => {}))
    await renderConnected(fetchImpl)
    vi.useFakeTimers()
    await act(async () => {
      sockets[0].message({
        protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2,
        eventType: 'player.shot', commandId: 'shot', committedAt: '',
        payload: {
          shotId: 'shot', shooterId: 'p2', facing: 'south', origin: { x: 11, y: 3 }, path: [{ x: 11, y: 4 }],
          victim: { ...snapshot.state.players[0], deathRevision: 2 },
        },
      })
    })
    return fetchImpl
  }

  afterEach(() => { vi.useRealTimers() })

  it('fires while alive without showing a rejoin prompt', async () => {
    const fetchImpl = fakeFetch(() => new Promise(() => {}))
    await renderConnected(fetchImpl)
    expect(space().defaultPrevented).toBe(true)
    await act(async () => {})
    expect(commands(fetchImpl)).toEqual(['player.shoot'])
    expect(screen.queryByRole('dialog', { name: 'You were defeated' })).toBeNull()
  })

  it('offers Rejoin as the primary action straight away and blocks movement and firing', async () => {
    const fetchImpl = await defeat()
    const rejoin = screen.getByRole('button', { name: 'Rejoin world' }) as HTMLButtonElement
    expect(rejoin.disabled).toBe(false)
    expect(rejoin.getAttribute('aria-keyshortcuts')).toBe('Space')
    expect(rejoin.querySelector('kbd')?.textContent).toBe('Space')
    expect(screen.getByText('Ready for another life?')).toBeTruthy()
    expect(screen.queryByText(/announcement/i)).toBeNull()

    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp' })
    fireEvent.keyUp(window, { key: 'ArrowUp', code: 'ArrowUp' })
    await act(async () => {})
    expect(commands(fetchImpl)).toEqual([])
  })

  it('rejoins once from a fresh Space press and ignores repeats and modifiers', async () => {
    const fetchImpl = await defeat()
    expect(screen.getByText('Ready for another life?')).toBeTruthy()

    space(window, { repeat: true })
    space(window, { shiftKey: true })
    space(window, { ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'You were defeated' })).toBeTruthy()

    // Two presses dispatched before React re-renders must not rejoin twice.
    const first = new KeyboardEvent('keydown', { code: 'Space', key: ' ', cancelable: true })
    const second = new KeyboardEvent('keydown', { code: 'Space', key: ' ', cancelable: true })
    act(() => { window.dispatchEvent(first); window.dispatchEvent(second) })
    expect(first.defaultPrevented).toBe(true)
    expect(screen.queryByRole('dialog', { name: 'You were defeated' })).toBeNull()
    await act(async () => {})
    expect(commands(fetchImpl)).toEqual(['player.place'])
  })

  it('does not rejoin while the world is disconnected', async () => {
    await defeat()
    act(() => sockets[0].close())
    expect((screen.getByRole('button', { name: 'Rejoin world' }) as HTMLButtonElement).disabled).toBe(true)

    space()
    expect(screen.getByRole('dialog', { name: 'You were defeated' })).toBeTruthy()
  })

  it('leaves Space on focused controls to the control itself', async () => {
    const fetchImpl = await defeat()
    const cleanView = screen.getByRole('button', { name: 'Clean view' })
    cleanView.focus()
    expect(space(cleanView).defaultPrevented).toBe(false)
    expect(screen.getByRole('dialog', { name: 'You were defeated' })).toBeTruthy()

    const rejoin = screen.getByRole('button', { name: 'Rejoin world' })
    rejoin.focus()
    expect(space(rejoin).defaultPrevented).toBe(false)
    expect(screen.getByRole('dialog', { name: 'You were defeated' })).toBeTruthy()
    // The browser activates a focused button on Space; that click is the only rejoin.
    fireEvent.click(rejoin)
    expect(screen.queryByRole('dialog', { name: 'You were defeated' })).toBeNull()
    await act(async () => {})
    expect(commands(fetchImpl)).toEqual(['player.place'])
  })
})

it('reuses terrain and resize setup across remote moves and a local death', async () => {
  const create = vi.spyOn(document, 'createElement')
  const observe = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect() {}; unobserve() {} })
  try {
    await renderConnected()
    const before = create.mock.calls.filter(([tag]) => tag === 'canvas').length
    const observersBefore = observe.mock.calls.length
    for (let revision = 2; revision <= 6; revision++) {
      sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision,
        eventType: 'player.moved', commandId: `c${revision}`, committedAt: '',
        payload: { ...snapshot.state.players[0], playerId: 'p2', x: revision + 12, positionRevision: revision } })
      await screen.findByText(`Synced · r${revision}`)
    }
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 7,
      eventType: 'player.shot', commandId: 'shot', committedAt: '',
      payload: { shotId: 'shot', shooterId: 'p1', shooterName: 'Marlowe', facing: 'east',
        origin: { x: 11, y: 4 }, path: [{ x: 12, y: 4 }], victim: snapshot.state.players[0] } })
    await screen.findByText('Synced · r7')
    expect(create.mock.calls.filter(([tag]) => tag === 'canvas')).toHaveLength(before)
    expect(observe).toHaveBeenCalledTimes(observersBefore)
  } finally { create.mockRestore() }
})

describe('player facing indicator', () => {
  const event = (revision: number, eventType: string, payload: object) => ({
    protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision, eventType, commandId: `c${revision}`, committedAt: '', payload,
  })
  const wren = { playerId: 'p2', name: 'Wren', avatar: 'shark', x: 13, y: 5, positionRevision: 1, facing: 'east' }
  const visualFor = (label: string) => {
    const visual = screen.getByText(label).previousElementSibling as HTMLElement
    expect(visual.classList.contains('player-marker-visual')).toBe(true)
    return visual
  }
  const badgeFor = (label: string) => {
    const badges = visualFor(label).querySelectorAll('.facing-indicator')
    expect(badges).toHaveLength(1)
    return badges[0] as HTMLElement
  }

  it('renders one centered badge beside the avatar inside the marker visual for local and remote players', async () => {
    await renderConnected(fakeFetch(undefined, { players: [...snapshot.state.players, wren] }))
    for (const [label, facing, sprite] of [['Marlowe', 'south', false], ['Wren', 'east', true]] as const) {
      const visual = visualFor(label)
      const badge = badgeFor(label)
      const avatar = visual.querySelector('.avatar-md') as HTMLElement
      // The arrow is drawn in CSS; the direction is carried by a modifier class and data attribute.
      expect(badge.textContent).toBe('')
      expect(badge.classList.contains(`facing-indicator--${facing}`)).toBe(true)
      expect(badge.getAttribute('data-facing')).toBe(facing)
      expect(badge.parentElement).toBe(visual)
      expect(badge.previousElementSibling).toBe(avatar)
      expect(avatar.contains(badge)).toBe(false)
      expect(avatar.classList.contains('avatar--sprite')).toBe(sprite)
      expect(Boolean(avatar.querySelector('img'))).toBe(sprite)
      // The marker anchors on the avatar alone; the badge and name are absolutely positioned siblings.
      expect(visual.parentElement?.classList.contains('player-marker')).toBe(true)
      expect(visual.nextElementSibling?.classList.contains('player-marker-name')).toBe(true)
    }
    expect(badgeFor('Wren').getAttribute('aria-hidden')).toBe('true')
    expect(visualFor('Marlowe').parentElement?.getAttribute('aria-hidden')).toBe('true')
  })

  it('switches to the correct direction class for all four authoritative facings as players move', async () => {
    await renderConnected(fakeFetch(undefined, { players: [...snapshot.state.players, wren] }))
    const facings = ['north', 'east', 'west', 'south'] as const
    const directionOf = (label: string) => {
      const badge = badgeFor(label)
      const classes = facings.filter((facing) => badge.classList.contains(`facing-indicator--${facing}`))
      // Exactly one direction modifier at a time, matching the data attribute.
      expect(classes).toHaveLength(1)
      expect(badge.getAttribute('data-facing')).toBe(classes[0])
      return classes[0]
    }
    let revision = 1
    let wrenFacing: string = 'east'
    for (const facing of facings) {
      sockets[0].message(event(++revision, 'player.moved', { ...snapshot.state.players[0], facing, positionRevision: revision }))
      await waitFor(() => expect(directionOf('Marlowe')).toBe(facing))
      // One player's turn never changes another marker's direction.
      expect(directionOf('Wren')).toBe(wrenFacing)
      sockets[0].message(event(++revision, 'player.moved', { ...wren, facing, positionRevision: revision }))
      await waitFor(() => expect(directionOf('Wren')).toBe(facing))
      wrenFacing = facing
    }
  })

  it('keeps the badge intact through avatar changes with no progression or shield decoration', async () => {
    await renderConnected(fakeFetch(undefined, { players: [...snapshot.state.players, wren] }))
    const visual = visualFor('Wren')
    expect(visual.querySelector('.shield-ring')).toBeNull()
    expect(visual.parentElement?.className).not.toMatch(/cosmetic-tier/)
    expect(visual.querySelector('.avatar-md')?.classList.contains('avatar--sprite')).toBe(true)

    sockets[0].message(event(2, 'player.avatar_changed', { ...wren, avatar: 'tide', positionRevision: 2 }))
    await waitFor(() => expect(visual.querySelector('.avatar-md')?.classList.contains('avatar--sprite')).toBe(false))
    expect(badgeFor('Wren').classList.contains('facing-indicator--east')).toBe(true)
    expect(visual.firstElementChild).toBe(visual.querySelector('.avatar-md'))
    expect(badgeFor('Wren').previousElementSibling).toBe(visual.querySelector('.avatar-md'))
  })
})

describe('clean view and fullscreen', () => {
  function memoryStorage() {
    const data = new Map<string, string>([[HOW_TO_PLAY_KEY, JSON.stringify({ version: HOW_TO_PLAY_VERSION, dismissed: true })]])
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      data,
    }
  }

  function installFullscreen() {
    let element: Element | null = null
    const request = vi.fn(async function (this: Element) { element = this; document.dispatchEvent(new Event('fullscreenchange')) })
    const exit = vi.fn(async () => { element = null; document.dispatchEvent(new Event('fullscreenchange')) })
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
    Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: request })
    return {
      request, exit,
      leaveFromBrowser() { element = null; document.dispatchEvent(new Event('fullscreenchange')) },
      uninstall() {
        for (const key of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen']) Reflect.deleteProperty(document, key)
        Reflect.deleteProperty(Element.prototype, 'requestFullscreen')
      },
    }
  }

  it('hides informational chrome in clean view while keeping gameplay controls, and restores it', async () => {
    render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl: fakeFetch(), storage: memoryStorage() }} />)
    await waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByText('Synced · r1')
    expect(screen.getByLabelText('World information')).toBeTruthy()
    // No stats, leaderboard, journal, or movable overlays remain.
    expect(screen.queryByLabelText('Your stats')).toBeNull()
    expect(screen.queryByLabelText('Combat leaderboard')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clean view' }))
    expect(screen.queryByLabelText('World information')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Party Conquest' })).toBeNull()
    expect(document.querySelector('.navigation-help')).toBeNull()
    // Gameplay controls stay available.
    expect(screen.getByRole('button', { name: 'Change avatar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore UI' }))
    expect(screen.getByLabelText('World information')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clean view' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clean view' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByLabelText('World information')).toBeTruthy()
  })

  it('enters and exits fullscreen from the control and tracks browser-driven exits', async () => {
    const fullscreen = installFullscreen()
    try {
      render(<MapCanvas player={null} token={null} syncDeps={{ fetchImpl: fakeFetch(), storage: memoryStorage() }} />)
      const button = screen.getByRole('button', { name: 'Enter fullscreen' })
      expect(button.getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(button)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Exit fullscreen' }).getAttribute('aria-pressed')).toBe('true'))
      expect(fullscreen.request).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeTruthy())
      expect(fullscreen.exit).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }))
      await screen.findByRole('button', { name: 'Exit fullscreen' })
      fullscreen.leaveFromBrowser()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Enter fullscreen' }).getAttribute('aria-pressed')).toBe('false'))
    } finally {
      fullscreen.uninstall()
    }
  })

  it('reports a rejected fullscreen request without breaking clean view', async () => {
    const fullscreen = installFullscreen()
    fullscreen.request.mockImplementation(async () => { throw new DOMException('denied', 'TypeError') })
    try {
      render(<MapCanvas player={null} token={null} syncDeps={{ fetchImpl: fakeFetch(), storage: memoryStorage() }} />)
      fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }))
      await screen.findByText('Fullscreen was blocked by the browser.')
      expect(screen.getByRole('button', { name: 'Enter fullscreen' }).getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(screen.getByRole('button', { name: 'Clean view' }))
      expect(screen.queryByLabelText('World information')).toBeNull()
      expect(screen.getByRole('button', { name: 'Restore UI' })).toBeTruthy()
    } finally {
      fullscreen.uninstall()
    }
  })

  it('disables fullscreen when the browser lacks the API and keeps clean view working', () => {
    render(<MapCanvas player={null} token={null} syncDeps={{ fetchImpl: fakeFetch(), storage: memoryStorage() }} />)
    const button = screen.getByRole('button', { name: 'Enter fullscreen' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Clean view' }))
    expect(screen.queryByLabelText('World information')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore UI' }))
    expect(screen.getByLabelText('World information')).toBeTruthy()
  })
})

describe('fit world toggle', () => {
  let resize!: (width: number, height: number) => void
  const ownMarker = () => document.querySelector<HTMLElement>('.player-marker') as HTMLElement
  const markerX = () => Number(/^translate\((\S+)px, (\S+)px\)/.exec(ownMarker().style.transform)?.[1])
  const fitButton = () => screen.getByRole('button', { name: 'Fit world in view' })
  const zoom = () => screen.getByLabelText(/^Current zoom /).textContent
  const moved = (revision: number, x: number, y = 40) => ({
    protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision,
    eventType: 'player.moved', commandId: `move-${revision}`, committedAt: '',
    payload: { playerId: player.id, name: player.name, avatar: player.avatar, x, y, positionRevision: revision, facing: 'east' },
  })
  // Start mid-world so a 400% camera can centre on the player without hitting the world edge clamp.
  async function renderMidWorld() {
    await renderConnected()
    sockets[0].message(moved(2, 40))
    await screen.findByText(/at column 41, row 41/)
    await waitFor(() => expect(markerX()).toBe(400))
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) { this.callback = callback }
      observe() {
        resize = (width, height) => this.callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver)
        resize(800, 600)
      }
      disconnect() {}
      unobserve() {}
    })
  })

  it('keeps the world fitted across player movement until the user toggles it off', async () => {
    await renderMidWorld()
    expect(fitButton().getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(fitButton())
    expect(fitButton().getAttribute('aria-pressed')).toBe('true')
    const fittedZoom = zoom()
    await waitFor(() => expect(markerX()).not.toBe(400))
    const fittedX = markerX()

    sockets[0].message(moved(3, 41))
    await screen.findByText(/at column 42, row 41/)
    // The camera stayed put: only the marker moved, by exactly one block at the fitted zoom.
    await waitFor(() => expect(markerX()).toBeCloseTo(fittedX + 8 * (parseInt(fittedZoom!, 10) / 100), 0))
    expect(fitButton().getAttribute('aria-pressed')).toBe('true')
    expect(zoom()).toBe(fittedZoom)

    fireEvent.click(fitButton())
    expect(fitButton().getAttribute('aria-pressed')).toBe('false')
    expect(zoom()).toBe('400%')
    await waitFor(() => expect(markerX()).toBe(400))

    sockets[0].message(moved(4, 42))
    await screen.findByText(/at column 43, row 41/)
    await waitFor(() => expect(markerX()).toBe(400))
  })

  it('re-fits on resize while active and exits when the user pans, zooms, or returns to the player', async () => {
    await renderMidWorld()
    fireEvent.click(fitButton())
    const fittedZoom = zoom()
    act(() => resize(1000, 600))
    expect(fitButton().getAttribute('aria-pressed')).toBe('true')
    expect(zoom()).not.toBe(fittedZoom)

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(fitButton().getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(fitButton())
    expect(fitButton().getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Return to player' }))
    expect(fitButton().getAttribute('aria-pressed')).toBe('false')
    expect(zoom()).toBe('400%')

    fireEvent.click(fitButton())
    fireEvent.wheel(document.querySelector('canvas') as HTMLCanvasElement, { deltaX: 40, deltaY: 0 })
    expect(fitButton().getAttribute('aria-pressed')).toBe('false')
  })
})

describe('smooth movement between grid positions', () => {
  const VIEWPORT = { width: 800, height: 600 }
  const FIT_ZOOM = fitWorld(WORLD, VIEWPORT, 40).zoom
  const cell = (x: number, y: number) => movementBlockCenter(x, y)
  const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const cameraAt = (center: Point, zoom = FIT_ZOOM): Camera => constrainCamera({ centerX: center.x, centerY: center.y, zoom }, WORLD, VIEWPORT)
  const transformAt = (world: Point, camera: Camera) => {
    const screen = worldToScreen(world, camera, VIEWPORT)
    return `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)`
  }
  const event = (revision: number, eventType: string, payload: object) => ({
    protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision,
    eventType, commandId: `c${revision}`, committedAt: '', payload,
  })
  const remote = (x: number, y: number, positionRevision: number) => ({ playerId: 'p2', name: 'Wren', avatar: 'tide', x, y, positionRevision, facing: 'east' })
  const localPlayer = (x: number, y: number, positionRevision: number) => ({ playerId: player.id, name: player.name, avatar: player.avatar, x, y, positionRevision, facing: 'east' })

  /** Flush React passive effects (motion reconciliation and draw scheduling) before advancing frames. */
  const settle = () => act(async () => {})

  /** Deterministic frame clock: performance.now and requestAnimationFrame advance only when a test says so. */
  function frameClock() {
    let now = 10_000
    let queue: FrameRequestCallback[] = []
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queue.push(callback); return queue.length })
    vi.stubGlobal('cancelAnimationFrame', () => { queue = [] })
    return {
      advance(ms: number) {
        now += ms
        const callbacks = queue
        queue = []
        callbacks.forEach((callback) => callback(now))
      },
      get pending() { return queue.length },
      restore() { nowSpy.mockRestore() },
    }
  }

  function sizedResizeObserver() {
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) { this.callback = callback }
      observe() { this.callback([{ contentRect: VIEWPORT } as ResizeObserverEntry], this as unknown as ResizeObserver) }
      disconnect() {}
      unobserve() {}
    })
  }

  async function renderWithRemote(fetchImpl = fakeFetch()) {
    sizedResizeObserver()
    const clock = frameClock()
    await renderConnected(fetchImpl)
    sockets[0].message(event(2, 'player.placed', remote(13, 5, 2)))
    const marker = await screen.findByLabelText('Wren, at column 14, row 6')
    await settle()
    clock.advance(16)
    const camera = cameraAt(cell(11, 4))
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), camera))
    return { clock, marker, camera }
  }

  let clock: ReturnType<typeof frameClock> | null = null
  afterEach(() => { clock?.restore(); clock = null })

  it('animates the local marker and camera at the standard cadence even when retired boost frames arrive', async () => {
    const { clock: frames } = await renderWithRemote()
    clock = frames
    await act(async () => {
      sockets[0].message({
        protocolVersion: 1, schemaVersion: 2, type: 'nitroStatus', chargeMs: 0,
        requiredMs: 30000, ready: false, activeRemainingMs: 10000, charging: false,
      })
      sockets[0].message({
        protocolVersion: 1, schemaVersion: 2, type: 'powerUpStatus', storedPowerUp: null, speedRemainingMs: 10000,
      })
      sockets[0].message(event(3, 'player.moved', localPlayer(12, 4, 3)))
    })
    await settle()
    const local = document.querySelector<HTMLElement>('.player-marker:not(.player-marker--remote)')!
    const duration = 80
    frames.advance(duration / 2)
    const displayed = midpoint(cell(11, 4), cell(12, 4))
    expect(local.style.transform).toBe(transformAt(displayed, cameraAt(displayed)))
    frames.advance(duration / 2)
    expect(local.style.transform).toBe(transformAt(cell(12, 4), cameraAt(cell(12, 4))))
    expect(frames.pending).toBe(0)
  })

  it('interpolates a remote adjacent step between cell centers and settles exactly on the new cell', async () => {
    const { clock: frames, marker, camera } = await renderWithRemote()
    clock = frames
    sockets[0].message(event(3, 'player.moved', remote(14, 5, 3)))
    await screen.findByLabelText('Wren, at column 15, row 6')
    await settle()
    frames.advance(0)
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), camera))
    frames.advance(40)
    expect(marker.style.transform).toBe(transformAt(midpoint(cell(13, 5), cell(14, 5)), camera))
    frames.advance(40)
    expect(marker.style.transform).toBe(transformAt(cell(14, 5), camera))
    frames.advance(16)
    expect(marker.style.transform).toBe(transformAt(cell(14, 5), camera))
    expect(frames.pending).toBe(0)
  })

  it('retargets a mid-animation step from the displayed point without replaying the stale segment', async () => {
    const { clock: frames, marker, camera } = await renderWithRemote()
    clock = frames
    sockets[0].message(event(3, 'player.moved', remote(14, 5, 3)))
    await screen.findByLabelText('Wren, at column 15, row 6')
    await settle()
    frames.advance(40)
    const displayed = midpoint(cell(13, 5), cell(14, 5))
    expect(marker.style.transform).toBe(transformAt(displayed, camera))
    sockets[0].message(event(4, 'player.moved', remote(14, 6, 4)))
    await screen.findByLabelText('Wren, at column 15, row 7')
    await settle()
    frames.advance(0)
    expect(marker.style.transform).toBe(transformAt(displayed, camera))
    // The second step arrived 40ms after the first. That is under the 60ms minimum
    // step duration, so the retarget glides at 60ms per cell over its longer diagonal.
    const retarget = Math.round(MIN_STEP_DURATION_MS * Math.hypot(0.5, 1))
    frames.advance(retarget / 2)
    expect(marker.style.transform).toBe(transformAt(midpoint(displayed, cell(14, 6)), camera))
    frames.advance(retarget / 2)
    expect(marker.style.transform).toBe(transformAt(cell(14, 6), camera))
  })

  it('snaps corrections larger than one orthogonal cell and reappearances after removal', async () => {
    const { clock: frames, marker, camera } = await renderWithRemote()
    clock = frames
    sockets[0].message(event(3, 'player.respawned', remote(30, 20, 3)))
    await screen.findByLabelText('Wren, at column 31, row 21')
    await settle()
    frames.advance(0)
    expect(marker.style.transform).toBe(transformAt(cell(30, 20), camera))
    expect(frames.pending).toBe(0)
    sockets[0].message(event(4, 'player.shot', {
      shotId: 'kill', shooterId: player.id, shooterName: player.name, facing: 'east',
      origin: { x: 11, y: 4 }, path: [{ x: 12, y: 4 }], victim: remote(30, 20, 3),
    }))
    await waitFor(() => expect(screen.queryByLabelText(/Wren,/)).toBeNull())
    await settle()
    sockets[0].message(event(5, 'player.respawned', remote(31, 20, 5)))
    const reappeared = await screen.findByLabelText('Wren, at column 32, row 21')
    await settle()
    frames.advance(0)
    expect(reappeared.style.transform).toBe(transformAt(cell(31, 20), camera))
    expect(frames.pending).toBe(0)
  })

  it('snaps adjacent steps and camera when reduced motion is requested', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { clock: frames, marker } = await renderWithRemote()
    clock = frames
    sockets[0].message(event(3, 'player.moved', remote(14, 5, 3)))
    await screen.findByLabelText('Wren, at column 15, row 6')
    await settle()
    frames.advance(0)
    expect(marker.style.transform).toBe(transformAt(cell(14, 5), cameraAt(cell(11, 4))))
    sockets[0].message(event(4, 'player.moved', localPlayer(12, 4, 4)))
    await screen.findByText('Marlowe at column 13, row 5')
    await settle()
    frames.advance(0)
    const local = document.querySelector<HTMLElement>('.player-marker:not(.player-marker--remote)')!
    expect(local.style.transform).toBe(transformAt(cell(12, 4), cameraAt(cell(12, 4))))
    expect(marker.style.transform).toBe(transformAt(cell(14, 5), cameraAt(cell(12, 4))))
    expect(document.querySelector('.grass-rustle')).toBeNull()
    expect(frames.pending).toBe(0)
  })

  it('follows the local interpolated position with the camera and still honours manual panning', async () => {
    const { clock: frames, marker } = await renderWithRemote()
    clock = frames
    fireEvent.click(screen.getByRole('button', { name: 'Return to player' }))
    await settle()
    frames.advance(16)
    const local = document.querySelector<HTMLElement>('.player-marker:not(.player-marker--remote)')!
    expect(local.style.transform).toBe(transformAt(cell(11, 4), cameraAt(cell(11, 4), 4)))

    sockets[0].message(event(3, 'player.moved', localPlayer(12, 4, 3)))
    await screen.findByText('Marlowe at column 13, row 5')
    await settle()
    frames.advance(40)
    const displayed = midpoint(cell(11, 4), cell(12, 4))
    expect(local.style.transform).toBe(transformAt(displayed, cameraAt(displayed, 4)))
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), cameraAt(displayed, 4)))
    frames.advance(40)
    expect(local.style.transform).toBe(transformAt(cell(12, 4), cameraAt(cell(12, 4), 4)))
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), cameraAt(cell(12, 4), 4)))
    expect(frames.pending).toBe(0)

    const canvas = screen.getByLabelText(/Interactive 80 by 80 block world/)
    fireEvent.wheel(canvas, { deltaX: 40, deltaY: 24 })
    await settle()
    frames.advance(16)
    const panned = constrainCamera(panBy(cameraAt(cell(12, 4), 4), { x: -40, y: -24 }), WORLD, VIEWPORT)
    expect(local.style.transform).toBe(transformAt(cell(12, 4), panned))
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), panned))
    frames.advance(16)
    expect(local.style.transform).toBe(transformAt(cell(12, 4), panned))
  })

  it('glides toward a keyboard move before the server confirms it and reconciles a rejected move back to the confirmed cell', async () => {
    const responses: ((response: Response) => void)[] = []
    const fetchImpl = fakeFetch(() => new Promise<Response>((resolve) => { responses.push(resolve) }))
    const { clock: frames, marker } = await renderWithRemote(fetchImpl)
    clock = frames
    fireEvent.click(screen.getByRole('button', { name: 'Return to player' }))
    await settle()
    frames.advance(16)
    const local = document.querySelector<HTMLElement>('.player-marker:not(.player-marker--remote)')!
    const halfway = midpoint(cell(11, 4), cell(12, 4))

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyUp(window, { key: 'ArrowRight' })
    await settle()
    frames.advance(40)
    // The marker and follow camera are already mid-glide; the static remote marker proves the world moved with them.
    expect(local.style.transform).toBe(transformAt(halfway, cameraAt(halfway, 4)))
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), cameraAt(halfway, 4)))
    // Gameplay text stays on the authoritative cell until the server confirms.
    expect(screen.getByText('Marlowe at column 12, row 5')).toBeTruthy()
    responses.shift()!(new Response(JSON.stringify({ event: event(3, 'player.moved', localPlayer(12, 4, 3)) }), { status: 201 }))
    await screen.findByText('Marlowe at column 13, row 5')
    await settle()
    frames.advance(40)
    expect(local.style.transform).toBe(transformAt(cell(12, 4), cameraAt(cell(12, 4), 4)))
    expect(frames.pending).toBe(0)

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyUp(window, { key: 'ArrowRight' })
    await settle()
    frames.advance(40)
    const blockedHalfway = midpoint(cell(12, 4), cell(13, 4))
    expect(local.style.transform).toBe(transformAt(blockedHalfway, cameraAt(blockedHalfway, 4)))
    responses.shift()!(new Response(JSON.stringify({ error: { code: 'blocked', message: 'That block is occupied.' } }), { status: 409 }))
    await screen.findByText('That block is occupied.')
    await settle()
    // The rejected prediction glides back at the same speed and settles exactly on the confirmed cell.
    frames.advance(20)
    const returning = midpoint(blockedHalfway, cell(12, 4))
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), cameraAt(returning, 4)))
    frames.advance(20)
    expect(local.style.transform).toBe(transformAt(cell(12, 4), cameraAt(cell(12, 4), 4)))
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), cameraAt(cell(12, 4), 4)))
    expect(screen.getByText('Marlowe at column 13, row 5')).toBeTruthy()
    expect(frames.pending).toBe(0)
  })

  const rustledCells = () => Array.from(document.querySelectorAll<HTMLElement>('.grass-rustle')).map((patch) => `${patch.dataset.cell}:${patch.className}`)

  it('rustles grass for local and remote adjacent steps onto land and clears it after the recovery', async () => {
    const { clock: frames } = await renderWithRemote()
    clock = frames
    expect(rustledCells()).toEqual([])
    sockets[0].message(event(3, 'player.moved', remote(14, 5, 3)))
    await screen.findByLabelText('Wren, at column 15, row 6')
    await settle()
    expect(rustledCells()).toEqual(['14,5:grass-rustle grass-rustle--east'])
    sockets[0].message(event(4, 'player.moved', localPlayer(11, 5, 4)))
    await screen.findByText('Marlowe at column 12, row 6')
    await settle()
    expect(rustledCells()).toEqual(['14,5:grass-rustle grass-rustle--east', '11,5:grass-rustle grass-rustle--south'])
    const patch = document.querySelector<HTMLElement>('.grass-rustle')!
    expect(patch.style.getPropertyValue('--grass-color')).toBe(grassColor(14, 5))
    frames.advance(16)
    // At this wide zoom the patch below row 5 would reach the wall on row 7, so it stays hidden.
    expect(patch.style.visibility).toBe('hidden')
    expect(patch.style.transform).toBe(transformAt(cell(14, 5), cameraAt(cell(11, 5))))
    await waitFor(() => expect(rustledCells()).toEqual([]), { timeout: 1_000 })
  })

  it('does not rustle for facing-only updates, respawns, or multi-cell corrections', async () => {
    const { clock: frames } = await renderWithRemote()
    clock = frames
    sockets[0].message(event(3, 'player.moved', { ...remote(13, 5, 3), facing: 'north' }))
    await settle()
    sockets[0].message(event(4, 'player.respawned', remote(30, 20, 4)))
    await screen.findByLabelText('Wren, at column 31, row 21')
    await settle()
    sockets[0].message(event(5, 'player.moved', localPlayer(13, 4, 5)))
    await screen.findByText('Marlowe at column 14, row 5')
    await settle()
    expect(rustledCells()).toEqual([])
  })

  it('keeps gliding across consecutive cells while earlier held moves are still unconfirmed', async () => {
    const fetchImpl = fakeFetch(() => new Promise<Response>(() => {}))
    const { clock: frames, marker } = await renderWithRemote(fetchImpl)
    clock = frames
    fireEvent.click(screen.getByRole('button', { name: 'Return to player' }))
    await settle()
    frames.advance(16)
    const posts = () => vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)).payload)

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await settle()
    frames.advance(80)
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), cameraAt(cell(12, 4), 4)))
    // The held repeat is sent against the first move's predicted cell without waiting for its confirmation.
    await waitFor(() => expect(posts()).toHaveLength(2), { timeout: 1_000 })
    fireEvent.keyUp(window, { key: 'ArrowRight' })
    expect(posts()[1]).toMatchObject({ expected: { x: 12, y: 4 }, destination: { x: 13, y: 4 } })
    await settle()
    frames.advance(40)
    const onward = midpoint(cell(12, 4), cell(13, 4))
    expect(marker.style.transform).toBe(transformAt(cell(13, 5), cameraAt(onward, 4)))
    // Releasing never sends more than the moves already submitted.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(posts()).toHaveLength(2)
  })

  describe('static map repaint', () => {
    const paints = vi.mocked(drawMap)
    beforeEach(() => paints.mockClear())

    it('keeps the painted map while remote markers and projectiles animate under a fixed camera', async () => {
      const { clock: frames, marker, camera } = await renderWithRemote()
      clock = frames
      expect(paints).toHaveBeenCalled()
      paints.mockClear()

      sockets[0].message(event(3, 'player.moved', remote(14, 5, 3)))
      await screen.findByLabelText('Wren, at column 15, row 6')
      await settle()
      frames.advance(40)
      expect(marker.style.transform).toBe(transformAt(midpoint(cell(13, 5), cell(14, 5)), camera))
      frames.advance(40)
      expect(marker.style.transform).toBe(transformAt(cell(14, 5), camera))

      sockets[0].message(event(4, 'mob.tick', {
        mobs: [{ mobId: 'r1', kind: 'ranged', x: 16, y: 4, facing: 'west', health: 3, maxHealth: 3, revision: 1 }],
        projectiles: [{ id: 's1', mobId: 'r1', x: 15, y: 4, facing: 'west', distance: 1 }], spawned: [], attacks: [],
      }))
      const projectile = await screen.findByTestId('mob-projectile')
      await settle()
      frames.advance(0)
      const launched = projectile.style.transform
      frames.advance(30)
      expect(projectile.style.transform).not.toBe(launched)
      while (frames.pending) frames.advance(30)
      expect(paints).not.toHaveBeenCalled()
    })

    it('repaints for pans, local-player following, resizes, and pixel-density changes', async () => {
      let resize: ((size: { width: number; height: number }) => void) | null = null
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) {
          resize = (size) => callback([{ contentRect: size } as ResizeObserverEntry], this as unknown as ResizeObserver)
        }
        observe() { resize!(VIEWPORT) }
        disconnect() {}
        unobserve() {}
      })
      const densityListeners: (() => void)[] = []
      vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
        matches: false, media: query,
        addEventListener: (_: string, listener: () => void) => { if (query.includes('resolution')) densityListeners.push(listener) },
        removeEventListener: (_: string, listener: () => void) => {
          if (densityListeners.includes(listener)) densityListeners.splice(densityListeners.indexOf(listener), 1)
        },
      })))
      clock = frameClock()
      await renderConnected()
      await settle()
      clock.advance(16)
      expect(paints).toHaveBeenCalledTimes(1)
      expect(paints.mock.lastCall?.[2]).toEqual(cameraAt(cell(11, 4)))

      const canvas = screen.getByLabelText(/Interactive 80 by 80 block world/)
      fireEvent.wheel(canvas, { deltaX: 40, deltaY: 24 })
      await settle()
      clock.advance(16)
      expect(paints).toHaveBeenCalledTimes(2)
      expect(paints.mock.lastCall?.[2]).toEqual(constrainCamera(panBy(cameraAt(cell(11, 4)), { x: -40, y: -24 }), WORLD, VIEWPORT))

      fireEvent.click(screen.getByRole('button', { name: 'Return to player' }))
      await settle()
      clock.advance(16)
      expect(paints).toHaveBeenCalledTimes(3)
      sockets[0].message(event(2, 'player.moved', localPlayer(12, 4, 2)))
      await screen.findByText('Marlowe at column 13, row 5')
      await settle()
      clock.advance(40)
      expect(paints.mock.lastCall?.[2]).toEqual(cameraAt(midpoint(cell(11, 4), cell(12, 4)), 4))
      clock.advance(40)
      expect(paints.mock.lastCall?.[2]).toEqual(cameraAt(cell(12, 4), 4))
      const followed = paints.mock.calls.length
      clock.advance(16)
      expect(paints).toHaveBeenCalledTimes(followed)

      await act(async () => resize!({ width: 640, height: 480 }))
      clock.advance(16)
      expect(paints).toHaveBeenCalledTimes(followed + 1)
      expect(paints.mock.lastCall?.[3]).toEqual({ width: 640, height: 480 })

      vi.stubGlobal('devicePixelRatio', 2)
      expect(densityListeners).toHaveLength(1)
      densityListeners[0]()
      clock.advance(16)
      expect(paints).toHaveBeenCalledTimes(followed + 2)
      expect(densityListeners).toHaveLength(1)
    })
  })
})
describe('enemy mob presentation', () => {
  it('renders hostile markers with health pips, flashes damage, and bursts on defeat', async () => {
    const mob = { mobId: 'm1', kind: 'basic', x: 13, y: 4, facing: 'west', health: 3, maxHealth: 3, revision: 1 }
    await renderConnectedWith(fakeFetch(undefined, { mobs: [mob] }))
    const marker = screen.getByRole('img', { name: 'Enemy mob with 3 of 3 health at column 14, row 5' })
    expect(marker.className).toContain('mob-marker--west')
    expect((marker.querySelector('.mob-health-bar-fill') as HTMLElement).style.width).toBe('100%')
    // The life bar sits above the body, fighting-game style.
    expect(marker.firstElementChild?.getAttribute('data-testid')).toBe('mob-health-bar')
    // The body is the world-space hitbox: the frame sizes it from the camera zoom, so zooming
    // scales the drawn body with the map and never changes which cells it covers.
    await waitFor(() => expect(marker.style.transform).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\)/))
    const bodyPixels = () => parseFloat(marker.style.getPropertyValue('--mob-body-size'))
    const zoom = () => parseFloat(screen.getByLabelText(/^Current zoom/).textContent!) / 100
    expect(bodyPixels()).toBeCloseTo(8 * 2.5 * zoom(), 1)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await waitFor(() => expect(bodyPixels()).toBeCloseTo(8 * 2.5 * zoom(), 1))
    expect(zoom()).toBeGreaterThan(1)
    sockets[0].message({
      protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2, eventType: 'player.shot', commandId: 'shot-2', committedAt: '',
      payload: { shotId: 'shot-2', shooterId: player.id, facing: 'east', origin: { x: 11, y: 4 }, path: [{ x: 12, y: 4 }, { x: 13, y: 4 }], victim: null, victims: [], mobHits: [{ ...mob, health: 1, revision: 2, defeated: false }] },
    })
    const hurt = await screen.findByRole('img', { name: 'Enemy mob with 1 of 3 health at column 14, row 5' })
    expect(hurt.className).toContain('mob-marker--hit')
    expect((hurt.querySelector('.mob-health-bar-fill') as HTMLElement).style.width).toBe('33%')
    sockets[0].message({
      protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 3, eventType: 'player.shot', commandId: 'shot-3', committedAt: '',
      payload: { shotId: 'shot-3', shooterId: player.id, facing: 'east', origin: { x: 11, y: 4 }, path: [{ x: 12, y: 4 }, { x: 13, y: 4 }], victim: null, victims: [], mobHits: [{ ...mob, health: 0, revision: 3, defeated: true }] },
    })
    await waitFor(() => expect(screen.queryByRole('img', { name: /Enemy mob/ })).toBeNull())
    expect(screen.getByTestId('mob-defeat')).toBeTruthy()
    expect(screen.queryByRole('img', { name: /gold/ })).toBeNull()
  })

  it('draws ranged enemies distinctly, with a wind-up cue and their projectile', async () => {
    const ranged = { mobId: 'r1', kind: 'ranged', x: 16, y: 4, facing: 'west', health: 3, maxHealth: 3, revision: 1, windingUp: true }
    const melee = { mobId: 'm1', kind: 'basic', x: 13, y: 8, facing: 'west', health: 3, maxHealth: 3, revision: 1 }
    await renderConnectedWith(fakeFetch(undefined, { mobs: [ranged, melee] }))
    const marker = screen.getByRole('img', { name: 'Ranged enemy winding up a shot with 3 of 3 health at column 17, row 5' })
    expect(marker.className).toContain('mob-marker--ranged')
    expect(marker.className).toContain('mob-marker--winding')
    expect(screen.getByRole('img', { name: /^Enemy mob with 3/ }).className).toContain('mob-marker--melee')
    expect(screen.queryByTestId('mob-projectile')).toBeNull()
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2, eventType: 'mob.tick', commandId: 'mob-2',
      payload: { mobs: [{ ...ranged, windingUp: false, revision: 2 }, melee], projectiles: [{ id: 's1', mobId: 'r1', x: 15.5, y: 4.2, facing: 'west', distance: 0.6, dx: -0.98, dy: 0.2 }], spawned: [], attacks: [] } })
    expect((await screen.findByTestId('mob-projectile')).getAttribute('aria-label')).toBe('Enemy rocket')
    expect(screen.getByRole('img', { name: 'Ranged enemy with 3 of 3 health at column 17, row 5' }).className).not.toContain('mob-marker--winding')
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 3, eventType: 'mob.tick', commandId: 'mob-3',
      payload: { mobs: [{ ...ranged, windingUp: false, revision: 3 }, melee], projectiles: [], spawned: [], attacks: [] } })
    await waitFor(() => expect(screen.queryByTestId('mob-projectile')).toBeNull())
  })
})

async function renderConnectedWith(fetchImpl: typeof fetch) {
  render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl }} />)
  await waitFor(() => expect(sockets).toHaveLength(1))
  sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
  await screen.findByText('Synced · r1')
}
function movementFetch() {
  let revision = 1
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/worlds/world-01/snapshot') return new Response(JSON.stringify(snapshot), { status: 200 })
    if (path === '/v1/worlds/world-01/commands' && init.method === 'POST') {
      const command = JSON.parse(String(init.body))
      revision += 1
      if (command.actionType === 'player.shoot') return new Response(JSON.stringify({ event: {
        protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision,
        eventType: 'player.shot', commandId: command.commandId, committedAt: '',
        payload: { shotId: command.commandId, shooterId: player.id, facing: 'east', origin: { x: 12, y: 4 }, path: [], victim: null },
      } }), { status: 201 })
      const { destination } = command.payload
      return new Response(JSON.stringify({ event: {
        protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision,
        eventType: 'player.moved', commandId: command.commandId, committedAt: '',
        payload: { playerId: player.id, name: player.name, avatar: player.avatar, ...destination, positionRevision: revision, facing: 'east' },
      } }), { status: 201 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

describe('virtual touch controls', () => {
  it('stays hidden on fine-pointer desktops', async () => {
    await renderConnected()
    expect(screen.queryByRole('group', { name: 'Touch controls' })).toBeNull()
    expect(document.querySelector('.map-viewport--touch')).toBeNull()
  })

  it('appears automatically on coarse pointers and drives held movement through the shared scheduler', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('pointer: coarse'), addEventListener() {}, removeEventListener() {} })))
    const fetchImpl = movementFetch()
    await renderConnected(fetchImpl)
    const commands = () => vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)))
    expect(document.querySelector('.map-viewport--touch')).not.toBeNull()
    const pad = screen.getByRole('group', { name: 'Touch controls' })
    for (const name of ['Move up', 'Move down', 'Move left', 'Move right', 'Fire']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    for (const name of [/special/i, /grenade/i, /taunt/i, /sprint/i, /nitro/i, /speed/i, /web/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }

    const right = screen.getByRole('button', { name: 'Move right' })
    fireEvent.pointerDown(right, { pointerId: 7, button: 0 })
    await screen.findByText('Marlowe at column 13, row 5')
    expect(commands()[0].payload.destination).toEqual({ x: 12, y: 4 })
    // Held press repeats at the keyboard cadence.
    await waitFor(() => expect(commands().length).toBeGreaterThanOrEqual(2), { timeout: 2500 })
    fireEvent.pointerUp(right, { pointerId: 7 })
    const afterRelease = commands().length
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(commands()).toHaveLength(afterRelease)

    fireEvent.click(screen.getByRole('button', { name: 'Fire' }))
    await waitFor(() => expect(commands().at(-1)?.actionType).toBe('player.shoot'))
    // Touch FIRE aims exactly like Space: the newest movement heading, never the click event.
    expect(commands().at(-1)?.payload).toMatchObject({ facing: 'east' })
    // FIRE reads as recharging for the cooldown, without becoming disabled.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fire' }).getAttribute('data-recharging')).toBe('true'))
    expect((screen.getByRole('button', { name: 'Fire' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('repeats a held touch press at the same 80 ms cadence as the keyboard', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('pointer: coarse'), addEventListener() {}, removeEventListener() {} })))
    const fetchImpl = movementFetch()
    await renderConnected(fetchImpl)
    const moves = () => vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)))
    vi.useFakeTimers()
    try {
      const right = screen.getByRole('button', { name: 'Move right' })
      fireEvent.pointerDown(right, { pointerId: 7, button: 0 })
      await act(async () => {})
      expect(moves()).toHaveLength(1)
      act(() => vi.advanceTimersByTime(79))
      expect(moves()).toHaveLength(1)
      act(() => vi.advanceTimersByTime(1))
      await act(async () => {})
      await vi.waitFor(() => expect(moves()).toHaveLength(2))
      fireEvent.pointerUp(right, { pointerId: 7 })
      act(() => vi.advanceTimersByTime(1_000))
      expect(moves()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays available in clean view like the other gameplay controls', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })))
    await renderConnected()
    fireEvent.click(screen.getByRole('button', { name: 'Clean view' }))
    expect(document.querySelector('.navigation-help')).toBeNull()
    expect(screen.getByRole('group', { name: 'Touch controls' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore UI' }))
    expect(screen.getByRole('group', { name: 'Touch controls' })).toBeTruthy()
  })
})

describe('Shift sprint', () => {
  const moves = (fetchImpl: typeof fetch) => vi.mocked(fetchImpl).mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)))
  async function tick(ms: number) {
    act(() => vi.advanceTimersByTime(ms))
    await act(async () => {})
  }

  afterEach(() => { vi.useRealTimers() })

  it('repeats every 40 ms while Shift is held, whichever key is pressed first, one cell per move', async () => {
    const fetchImpl = movementFetch()
    await renderConnected(fetchImpl)
    vi.useFakeTimers()
    fireEvent.keyDown(window, { key: 'Shift' })
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })
    await act(async () => {})
    expect(moves(fetchImpl)).toHaveLength(1)
    await tick(39)
    expect(moves(fetchImpl)).toHaveLength(1)
    await tick(1)
    expect(moves(fetchImpl)).toHaveLength(2)
    await tick(40)
    expect(moves(fetchImpl).map((move) => move.payload.destination)).toEqual([{ x: 12, y: 4 }, { x: 13, y: 4 }, { x: 14, y: 4 }])
    fireEvent.keyUp(window, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyUp(window, { key: 'Shift' })
    await tick(1_000)
    expect(moves(fetchImpl)).toHaveLength(3)

    // Shift-modified letters arrive uppercase; they still steer and release cleanly.
    fireEvent.keyDown(window, { key: 'D', shiftKey: true })
    await act(async () => {})
    expect(moves(fetchImpl)).toHaveLength(4)
    await tick(40)
    expect(moves(fetchImpl)).toHaveLength(5)
    fireEvent.keyUp(window, { key: 'd' })
    await tick(1_000)
    expect(moves(fetchImpl)).toHaveLength(5)
  })

  it('changes cadence live when Shift is pressed or released without an extra or stopped move', async () => {
    const fetchImpl = movementFetch()
    await renderConnected(fetchImpl)
    vi.useFakeTimers()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await act(async () => {})
    expect(moves(fetchImpl)).toHaveLength(1)
    await tick(20)
    // Accelerates the pending repeat to 40 ms after the last step instead of stepping now.
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true })
    await act(async () => {})
    expect(moves(fetchImpl)).toHaveLength(1)
    await tick(19)
    expect(moves(fetchImpl)).toHaveLength(1)
    await tick(1)
    expect(moves(fetchImpl)).toHaveLength(2)
    // Auto-repeated Shift keydowns change nothing.
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true, repeat: true })
    await tick(40)
    expect(moves(fetchImpl)).toHaveLength(3)
    // Releasing Shift returns to the standard cadence and keeps moving.
    fireEvent.keyUp(window, { key: 'Shift' })
    await act(async () => {})
    expect(moves(fetchImpl)).toHaveLength(3)
    await tick(79)
    expect(moves(fetchImpl)).toHaveLength(3)
    await tick(1)
    expect(moves(fetchImpl)).toHaveLength(4)
    fireEvent.keyUp(window, { key: 'ArrowRight' })
    await tick(1_000)
    expect(moves(fetchImpl)).toHaveLength(4)
  })

  it('stops sprinting on focus loss and leaves touch movement at the standard cadence', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('pointer: coarse'), addEventListener() {}, removeEventListener() {} })))
    const fetchImpl = movementFetch()
    await renderConnected(fetchImpl)
    vi.useFakeTimers()
    fireEvent.keyDown(window, { key: 'Shift' })
    const right = screen.getByRole('button', { name: 'Move right' })
    fireEvent.pointerDown(right, { pointerId: 7, button: 0 })
    await act(async () => {})
    expect(moves(fetchImpl)).toHaveLength(1)
    await tick(79)
    expect(moves(fetchImpl)).toHaveLength(1)
    await tick(1)
    expect(moves(fetchImpl)).toHaveLength(2)
    fireEvent.pointerUp(right, { pointerId: 7 })
    // Let both touch moves settle so the in-flight limit cannot hold the next press.
    await vi.waitFor(() => expect(screen.getByText('Marlowe at column 14, row 5')).toBeTruthy())

    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })
    await act(async () => {})
    expect(moves(fetchImpl)).toHaveLength(3)
    act(() => { window.dispatchEvent(new Event('blur')) })
    await tick(1_000)
    expect(moves(fetchImpl)).toHaveLength(3)
  })
})

describe('R taunt', () => {
  const wren = { playerId: 'p2', name: 'Wren', avatar: 'shark', x: 13, y: 5, positionRevision: 1, facing: 'east' }
  const taunts = () => sockets[0].sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === 'taunt')
  const press = (init: KeyboardEventInit, target: EventTarget = window) => {
    const event = new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true, ...init })
    act(() => { target.dispatchEvent(event) })
    return event
  }
  const visualFor = (label: string) => screen.getByText(label).previousElementSibling as HTMLElement
  const taunt = (playerId: string) => act(() => {
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'taunt', worldId: 'world-01', playerId })
  })

  afterEach(() => { vi.useRealTimers() })

  it('sends one taunt per fresh R press, including while sprinting, and leaves modified and typed R alone', async () => {
    await renderConnected()
    expect(press({}).defaultPrevented).toBe(true)
    expect(taunts()).toEqual([{ protocolVersion: 1, schemaVersion: 2, type: 'taunt', worldId: 'world-01' }])
    press({ repeat: true })
    expect(taunts()).toHaveLength(1)
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(press({ [modifier]: true }).defaultPrevented).toBe(false)
    }
    const input = document.createElement('input')
    document.body.append(input)
    press({}, input)
    input.remove()
    expect(taunts()).toHaveLength(1)
    press({ key: 'R', shiftKey: true })
    expect(taunts()).toHaveLength(2)
  })

  it('ignores R while signed out or not placed', async () => {
    render(<MapCanvas player={null} token={null} syncDeps={{ fetchImpl: fakeFetch() }} />)
    await waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
    await screen.findByText('Synced · r1')
    press({})
    expect(taunts()).toEqual([])
    cleanup()
    sockets = []

    await renderConnected(fakeFetch(() => new Promise(() => {}), { players: [] }))
    press({})
    expect(taunts()).toEqual([])
  })

  it('does not interrupt held movement or sprinting', async () => {
    const fetchImpl = movementFetch()
    await renderConnected(fetchImpl)
    vi.useFakeTimers()
    const moves = () => vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST')
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })
    await act(async () => {})
    press({ key: 'R', shiftKey: true })
    act(() => vi.advanceTimersByTime(40))
    await act(async () => {})
    expect(moves()).toHaveLength(2)
    expect(taunts()).toHaveLength(1)
    fireEvent.keyUp(window, { key: 'ArrowRight' })
  })

  it('buzzes the taunting local or remote marker briefly and ignores unknown players', async () => {
    await renderConnected(fakeFetch(undefined, { players: [...snapshot.state.players, wren] }))
    vi.useFakeTimers()
    taunt('p2')
    expect(visualFor('Wren').classList.contains('player-marker-visual--taunting')).toBe(true)
    expect(visualFor('Marlowe').classList.contains('player-marker-visual--taunting')).toBe(false)
    taunt('p1')
    expect(visualFor('Marlowe').classList.contains('player-marker-visual--taunting')).toBe(true)
    taunt('ghost')
    expect(document.querySelectorAll('.player-marker-visual--taunting')).toHaveLength(2)
    act(() => vi.advanceTimersByTime(500))
    expect(document.querySelectorAll('.player-marker-visual--taunting')).toHaveLength(0)
    // Cosmetic only: coordinates and facing are untouched.
    expect(screen.getByText('Marlowe at column 12, row 5')).toBeTruthy()
    expect(visualFor('Wren').querySelector('.facing-indicator')?.getAttribute('data-facing')).toBe('east')
  })
})

describe('laser aim guide and flash', () => {
  const shotEvent = (revision: number, payload: object) => ({
    protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision, eventType: 'player.shot', commandId: `shot-${revision}`, committedAt: '',
    payload: { shooterId: player.id, shooterName: player.name, facing: 'east', origin: { x: 11, y: 4 }, victim: null, ...payload },
  })

  it('previews the reachable lane in the committed facing, shortened by terrain', async () => {
    await renderConnected()
    const lane = laserLane({ x: 11, y: 4 }, 'south')
    const stop = laserStop({ x: 11, y: 4 }, lane, 'south')
    expect(screen.getAllByTestId('laser-aim')).toHaveLength(lane.length)
    expect(screen.queryAllByTestId('laser-aim-stop')).toHaveLength(stop ? 1 : 0)
    expect(screen.getByTestId('laser-aim-label').getAttribute('aria-label')).toBe(
      `Laser aimed south, ${lane.length} squares${stop ? ' to the terrain' : ' to the map edge'}`)
    expect(screen.getAllByTestId('laser-aim')[0].className).toContain('laser-aim--vertical')
  })

  it('ends the guide on the first visible player or mob in line, far beyond four cells', async () => {
    const far = { playerId: 'p2', name: 'Wren', avatar: 'tide', x: 30, y: 4, positionRevision: 1, facing: 'west' }
    const behind = { playerId: 'p3', name: 'Finch', avatar: 'ember', x: 40, y: 4, positionRevision: 1, facing: 'west' }
    await renderConnected(fakeFetch(undefined, { players: [{ ...snapshot.state.players[0], facing: 'east' }, far, behind] }))
    expect(screen.getAllByTestId('laser-aim')).toHaveLength(19)
    expect(screen.queryAllByTestId('laser-aim-stop')).toHaveLength(0)
    expect(screen.getByTestId('laser-aim-label').getAttribute('aria-label')).toBe('Laser aimed east, 19 squares to a target')
  })

  it('ends the guide where an off-lane enemy body meets the beam, as the server resolves it', async () => {
    const behind = { playerId: 'p2', name: 'Wren', avatar: 'tide', x: 25, y: 4, positionRevision: 1, facing: 'west' }
    const grazed = { mobId: 'm1', kind: 'basic', x: 20, y: 5, facing: 'west', health: 3, maxHealth: 3, revision: 1 }
    const clear = { mobId: 'm2', kind: 'ranged', x: 16, y: 6, facing: 'west', health: 3, maxHealth: 3, revision: 1 }
    await renderConnected(fakeFetch(undefined, { players: [{ ...snapshot.state.players[0], facing: 'east' }, behind], mobs: [grazed, clear] }))
    // The melee body one row down reaches the lane at x 18.75, inside lane cell 8 (x 19); two rows down misses.
    expect(screen.getAllByTestId('laser-aim')).toHaveLength(8)
    expect(screen.getByTestId('laser-aim-label').getAttribute('aria-label')).toBe('Laser aimed east, 8 squares to a target')
  })

  it('re-aims on a movement press and fires that heading once the pending move settles', async () => {
    let confirmMove!: (response: Response) => void
    let revision = 1
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/worlds/world-01/snapshot') return new Response(JSON.stringify(snapshot), { status: 200 })
      if (path === '/v1/worlds/world-01/commands' && init.method === 'POST') {
        const command = JSON.parse(String(init.body))
        revision += 1
        if (command.actionType === 'player.move') return new Promise<Response>((resolve) => { confirmMove = resolve })
        return new Response(JSON.stringify({ event: shotEvent(revision, { shotId: command.commandId, origin: { x: 12, y: 4 }, path: [] }) }), { status: 201 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const posted = () => vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)))
    await renderConnected(fetchImpl)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    fireEvent.keyUp(window, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getAllByTestId('laser-aim')[0].className).toContain('laser-aim--horizontal'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(posted().map((command) => command.actionType)).toEqual(['player.move'])

    confirmMove(new Response(JSON.stringify({ event: {
      protocolVersion: 1, schemaVersion: 2, type: 'event', worldId: 'world-01', revision: 2, eventType: 'player.moved', commandId: posted()[0].commandId, committedAt: '',
      payload: { ...snapshot.state.players[0], x: 12, positionRevision: 2, facing: 'east' },
    } }), { status: 201 }))
    await waitFor(() => expect(posted().map((command) => command.actionType)).toEqual(['player.move', 'player.shoot']))
    expect(posted()[1].payload).toMatchObject({ facing: 'east', expectedRevision: 2 })
  })

  it('flashes every lane cell once, caps only a terrain stop, and rings the unit it hits', async () => {
    const wren = { playerId: 'p2', name: 'Wren', avatar: 'tide', x: 20, y: 4, positionRevision: 1, facing: 'west' }
    await renderConnected(fakeFetch(undefined, { players: [...snapshot.state.players, wren] }))
    const toWren = Array.from({ length: 9 }, (_, index) => ({ x: 12 + index, y: 4 }))
    act(() => sockets[0].message(shotEvent(2, { shotId: 'hit', path: toWren, victim: wren, victims: [wren] })))
    expect(screen.getAllByTestId('laser-beam')).toHaveLength(9)
    expect(screen.getAllByTestId('laser-beam')[0].className).toContain('laser-beam--horizontal')
    // A unit ends the beam on its own cell: an impact ring, not a terrain cap.
    expect(screen.queryAllByTestId('laser-stop')).toHaveLength(0)
    expect(screen.getAllByTestId('laser-impact')).toHaveLength(1)
    expect(screen.getByTestId('laser-shot-label').getAttribute('aria-label')).toBe('Marlowe fired a laser east, 9 squares, hitting a player')

    const lane = laserLane({ x: 11, y: 4 }, 'east')
    act(() => sockets[0].message(shotEvent(3, { shotId: 'miss', path: lane })))
    expect(screen.getAllByTestId('laser-beam')).toHaveLength(lane.length)
    expect(screen.queryAllByTestId('laser-stop')).toHaveLength(laserStop({ x: 11, y: 4 }, lane, 'east') ? 1 : 0)
    expect(screen.queryAllByTestId('laser-impact')).toHaveLength(0)

    act(() => sockets[0].message(shotEvent(4, { shotId: 'mob', path: toWren.slice(0, 3), mobHits: [{ mobId: 'm1', x: 14, y: 4 }] })))
    expect(screen.getAllByTestId('laser-impact')).toHaveLength(1)
    expect(screen.getByTestId('laser-shot-label').getAttribute('aria-label')).toBe('Marlowe fired a laser east, 3 squares, hitting a mob')
    await waitFor(() => expect(screen.queryAllByTestId('laser-beam')).toHaveLength(0), { timeout: 2000 })
  })

  it('draws a static flash under reduced motion and hides the guide once defeated', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} })))
    await renderConnected()
    act(() => sockets[0].message({ ...shotEvent(2, {
      shotId: 'fatal', shooterId: 'p2', shooterName: 'Wren', facing: 'south', origin: { x: 11, y: 3 }, path: [{ x: 11, y: 4 }],
      victim: { ...snapshot.state.players[0], deathRevision: 2 },
    }) }))
    expect(screen.getAllByTestId('laser-beam')[0].className).toContain('laser--reduced')
    expect(screen.getAllByTestId('laser-impact')[0].className).toContain('laser--reduced')
    expect(screen.queryAllByTestId('laser-aim')).toHaveLength(0)
  })
})
