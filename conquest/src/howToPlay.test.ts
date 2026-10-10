import { expect, it } from 'vitest'
import { HOW_TO_PLAY_KEY, HOW_TO_PLAY_VERSION, hasSeenHowToPlay, markHowToPlaySeen } from './howToPlay'
import type { StorageLike } from './session/storage'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    data,
  }
}

it('shows the panel on a fresh device and remembers the dismissal', () => {
  const storage = memoryStorage()
  expect(hasSeenHowToPlay(storage)).toBe(false)
  markHowToPlaySeen(storage)
  expect(JSON.parse(storage.data.get(HOW_TO_PLAY_KEY)!)).toEqual({ version: HOW_TO_PLAY_VERSION, dismissed: true })
  expect(hasSeenHowToPlay(storage)).toBe(true)
})

it('treats malformed, outdated, or unreadable preferences as a first visit', () => {
  expect(hasSeenHowToPlay(null)).toBe(false)
  expect(hasSeenHowToPlay(memoryStorage({ [HOW_TO_PLAY_KEY]: '{not json' }))).toBe(false)
  expect(hasSeenHowToPlay(memoryStorage({ [HOW_TO_PLAY_KEY]: JSON.stringify({ version: 0, dismissed: true }) }))).toBe(false)
  expect(hasSeenHowToPlay(memoryStorage({ [HOW_TO_PLAY_KEY]: JSON.stringify({ version: HOW_TO_PLAY_VERSION, dismissed: 'yes' }) }))).toBe(false)
  const throwing: StorageLike = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => {},
  }
  expect(hasSeenHowToPlay(throwing)).toBe(false)
  expect(() => markHowToPlaySeen(throwing)).not.toThrow()
})
