// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MapCanvas } from './components/MapCanvas'
import { HOW_TO_PLAY_KEY, HOW_TO_PLAY_VERSION } from './howToPlay'
import type { Player } from './session/types'

const player: Player = { id: 'p1', name: 'Arjun', avatar: 'moss', customAvatar: null, createdAt: 1, lastSeenAt: 2 }
beforeEach(() => {
  localStorage.setItem(HOW_TO_PLAY_KEY, JSON.stringify({ version: HOW_TO_PLAY_VERSION, dismissed: true }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('WebSocket', class { addEventListener() {} close() {} send() {} })
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })



it.each(['Robert <img src=x> & ' + 'LongName'.repeat(12), '', null, 42])('renders durable attribution safely: %s', async (name) => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    protocolVersion: 1, schemaVersion: 2, worldId: 'world-01', revision: 1,
    state: { players: [], eliminated: { p1: 1 }, deathAttribution: { p1: name } },
  }), { status: 200 }))
  render(<MapCanvas player={player} token="token" syncDeps={{ fetchImpl }} />)
  const dialog = await screen.findByRole('dialog', { name: 'You were defeated' })
  const heading = within(dialog).getByRole('heading')
  expect(heading.textContent).toBe(typeof name === 'string' && name ? `You were obliterated by ${name}.` : 'You were obliterated.')
  expect(heading.querySelector('img')).toBeNull()
  expect(heading.querySelector('strong')?.textContent ?? null).toBe(typeof name === 'string' && name ? name : null)
})
