// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { HOW_TO_PLAY_KEY, HOW_TO_PLAY_VERSION } from '../howToPlay'
import type { StorageLike } from '../session/storage'
import type { Player } from '../session/types'
import { MapCanvas } from './MapCanvas'

const player: Player = { id: 'p1', name: 'Marlowe', avatar: 'moss', customAvatar: null, createdAt: 1, lastSeenAt: 2 }
let sockets: TestWebSocket[] = []

class TestWebSocket {
  listeners = new Map<string, ((event: Event | MessageEvent) => void)[]>()
  constructor() { sockets.push(this) }
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

const snapshot = {
  protocolVersion: 1, schemaVersion: 2, worldId: 'world-01', revision: 1,
  state: { players: [{ playerId: player.id, name: player.name, avatar: player.avatar, x: 11, y: 4, positionRevision: 1, facing: 'south' }] },
}

function fakeFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/worlds/world-01/snapshot') return new Response(JSON.stringify(snapshot), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    data,
  }
}

const posts = (fetchImpl: typeof fetch) => vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST')

async function renderConnected(storage = memoryStorage(), fetchImpl = fakeFetch()) {
  const view = render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl, storage }} />)
  await waitFor(() => expect(sockets).toHaveLength(1))
  sockets[0].message({ protocolVersion: 1, schemaVersion: 2, type: 'ready', worldId: 'world-01', revision: 1 })
  await screen.findByText('Synced · r1')
  return { ...view, storage, fetchImpl }
}

const panel = () => screen.queryByRole('dialog', { name: 'How to play' })
const dockButton = () => screen.getByRole('button', { name: 'How to play' })

beforeEach(() => {
  sockets = []
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {}; unobserve() {} })
  vi.stubGlobal('WebSocket', TestWebSocket)
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('first visit', () => {
  it('opens on a fresh device with the objective, laser context, and keyboard controls, and focuses Got it', async () => {
    await renderConnected()
    const dialog = panel()!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByText(/Roam the shared world and battle other players and mobs/)).toBeTruthy()
    expect(within(dialog).getByText(/Your laser fires instantly the way you last moved and hits the first player or mob/)).toBeTruthy()
    const keyboard = within(dialog).getByLabelText('Keyboard controls')
    for (const action of ['Move', 'Hold while moving to sprint at double speed', 'Taunt other players', 'Fire your laser the way you face']) {
      expect(within(keyboard).getByText(action)).toBeTruthy()
    }
    // Space still rejoins in game, but only firing is taught for it.
    expect(within(keyboard).queryByText('Rejoin after you are defeated')).toBeNull()
    expect(within(keyboard).getAllByText('Space')).toHaveLength(1)
    // Stealth was retired (Issue #110): no C shortcut and no stealth guidance.
    expect(within(keyboard).queryByText('C')).toBeNull()
    // Only retained actions are taught.
    expect(dialog.textContent).not.toMatch(/grenade|gold|shop|shield|nitro|steal|hidden|detected|self-destruct|door|special|leader|level|xp\b/i)
    expect(within(keyboard).getByText('Shift')).toBeTruthy()
    expect(within(keyboard).getByText('R')).toBeTruthy()
    expect(within(dialog).getByLabelText('Map navigation controls').textContent).toContain('⌘/Ctrl')
    expect(within(dialog).queryByLabelText('Touch controls')).toBeNull()
    // The panel sits above the map's isolated stacking context and the sign-in dialog.
    expect(dialog.closest('.how-to-play-backdrop')?.parentElement).toBe(document.body)
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Got it' })))
  })

  it('shows touch controls in touch mode', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })))
    await renderConnected()
    const touch = within(panel()!).getByLabelText('Touch controls')
    expect(within(touch).getByText('Hold the arrow pad to move')).toBeTruthy()
    expect(within(touch).getByText('Fire your laser the way you face')).toBeTruthy()
    expect(within(touch).getByText('Pinch')).toBeTruthy()
    expect(within(touch).getByText('Come back after you are defeated')).toBeTruthy()
    expect(panel()!.textContent).toMatch(/Change avatar is in the Player actions button next to the pad/)
    expect(panel()!.textContent).not.toMatch(/grenade|nitro|taunt|sprint|shift|steal|hidden|detected|self-destruct|special/i)
    expect(within(panel()!).queryByLabelText('Keyboard controls')).toBeNull()
  })

  it('ignores gameplay keys while open, then accepts them once dismissed', async () => {
    const { fetchImpl } = await renderConnected()
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW' })
    fireEvent.keyDown(window, { key: ' ', code: 'Space' })
    fireEvent.keyDown(window, { key: 'g', code: 'KeyG' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(posts(fetchImpl)).toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Party Conquest world map' }).querySelector('canvas')?.tabIndex).toBe(-1)

    fireEvent.click(within(panel()!).getByRole('button', { name: 'Got it' }))
    expect(panel()).toBeNull()
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW' })
    await waitFor(() => expect(posts(fetchImpl).length).toBeGreaterThan(0))
  })

  it.each([
    ['Got it', () => fireEvent.click(within(panel()!).getByRole('button', { name: 'Got it' }))],
    ['the close button', () => fireEvent.click(within(panel()!).getByRole('button', { name: 'Close How to play' }))],
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
  ])('dismisses with %s and stays closed on the next load', async (_, dismiss) => {
    const { storage, unmount } = await renderConnected()
    dismiss()
    expect(panel()).toBeNull()
    expect(JSON.parse(storage.data.get(HOW_TO_PLAY_KEY)!)).toEqual({ version: HOW_TO_PLAY_VERSION, dismissed: true })
    unmount()
    sockets = []
    await renderConnected(storage)
    expect(panel()).toBeNull()
  })

  it('keeps Tab focus inside the panel', async () => {
    const user = userEvent.setup()
    await renderConnected()
    const dialog = panel()!
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Got it' })))
    await user.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
    await user.tab({ shift: true })
    await user.tab({ shift: true })
    await user.tab({ shift: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})

describe('How to play button', () => {
  it('leads the control dock with a text label, reopens the panel, and survives clean view', async () => {
    const storage = memoryStorage()
    storage.setItem(HOW_TO_PLAY_KEY, JSON.stringify({ version: HOW_TO_PLAY_VERSION, dismissed: true }))
    await renderConnected(storage)
    expect(panel()).toBeNull()
    const button = dockButton()
    expect(button.parentElement?.classList.contains('control-dock')).toBe(true)
    expect(button.parentElement?.firstElementChild).toBe(button)
    expect(button.textContent).toContain('How to play')
    expect(button.classList.contains('how-to-play-button--highlight')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Clean view' }))
    expect(dockButton()).toBeTruthy()
    fireEvent.click(dockButton())
    expect(panel()).toBeTruthy()
    expect(within(panel()!).queryByText('Rejoin after you are defeated')).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(panel()).toBeNull()
    // Reopening never earns the first-visit glow.
    expect(dockButton().classList.contains('how-to-play-button--highlight')).toBe(false)
  })

  it('glows after the first-visit panel is dismissed', async () => {
    await renderConnected()
    expect(dockButton().classList.contains('how-to-play-button--highlight')).toBe(false)
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Got it' }))
    await waitFor(() => expect(dockButton().classList.contains('how-to-play-button--highlight')).toBe(true))
    fireEvent.click(dockButton())
    expect(dockButton().classList.contains('how-to-play-button--highlight')).toBe(false)
  })
})

it('opens above the sign-in dialog for a signed-out first visit', async () => {
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  render(<App storage={memoryStorage()} fetchImpl={fetchImpl} />)
  expect(screen.getByRole('dialog', { name: 'Join Party Conquest' })).toBeTruthy()
  const dialog = panel()!
  expect(dialog.closest('.how-to-play-backdrop')?.parentElement).toBe(document.body)
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Got it' })))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(panel()).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Join Party Conquest' })).toBeTruthy()
})
