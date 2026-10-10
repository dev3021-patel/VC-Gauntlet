import { describe, expect, it } from 'vitest'
import {
  SESSION_STORAGE_KEY,
  SESSION_STORAGE_VERSION,
  clearSession,
  loadSession,
  parseStoredSession,
  saveSession,
  serializeSession,
  type StorageLike,
} from './storage'

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

const player = { id: 'p1', name: 'Wren', avatar: 'tide' as const, customAvatar: null, createdAt: 1, lastSeenAt: 2 }

describe('stored session parsing', () => {
  it('round-trips a valid session', () => {
    expect(parseStoredSession(serializeSession({ token: 'tok', player }))).toEqual({ token: 'tok', player })
  })

  it('restores a former shop avatar and drops the retired ownership list', () => {
    const skull = { ...player, avatar: 'skull' as const }
    expect(parseStoredSession(serializeSession({ token: 'tok', player: skull }))).toEqual({ token: 'tok', player: skull })
    const legacy = { ...skull, unlockedAvatars: ['robot', 'skull'] }
    expect(parseStoredSession(JSON.stringify({ version: SESSION_STORAGE_VERSION, token: 'tok', player: legacy }))).toEqual({ token: 'tok', player: skull })
  })

  it('restores an uploaded avatar and drops malformed or pre-upload custom fields', () => {
    const custom = `custom-${'a'.repeat(32)}-0000beef` as const
    const uploaded = { ...player, avatar: custom, customAvatar: custom }
    expect(parseStoredSession(serializeSession({ token: 'tok', player: uploaded }))).toEqual({ token: 'tok', player: uploaded })
    const { customAvatar: _omitted, ...legacy } = player
    expect(parseStoredSession(JSON.stringify({ version: SESSION_STORAGE_VERSION, token: 'tok', player: legacy }))?.player.customAvatar).toBeNull()
    expect(parseStoredSession(JSON.stringify({ version: SESSION_STORAGE_VERSION, token: 'tok', player: { ...player, customAvatar: 'custom-evil' } }))?.player.customAvatar).toBeNull()
  })

  it('returns null for missing or malformed data', () => {
    expect(parseStoredSession(null)).toBeNull()
    expect(parseStoredSession('')).toBeNull()
    expect(parseStoredSession('{not json')).toBeNull()
    expect(parseStoredSession('42')).toBeNull()
  })

  it('returns null for incompatible versions and invalid shapes', () => {
    expect(parseStoredSession(JSON.stringify({ version: 1, player: { handle: 'Wren', avatar: 'tide' } }))).toBeNull()
    expect(parseStoredSession(JSON.stringify({ version: SESSION_STORAGE_VERSION, player }))).toBeNull()
    expect(parseStoredSession(JSON.stringify({ version: SESSION_STORAGE_VERSION, token: 'tok', player: { ...player, avatar: 'unicorn' } }))).toBeNull()
    expect(parseStoredSession(JSON.stringify({ version: SESSION_STORAGE_VERSION, token: 'tok', player: { ...player, id: '' } }))).toBeNull()
  })
})

describe('load, save, clear', () => {
  it('saves then loads then clears', () => {
    const storage = memoryStorage()
    expect(saveSession({ token: 'tok', player }, storage)).toBe(true)
    expect(loadSession(storage)).toEqual({ token: 'tok', player })
    clearSession(storage)
    expect(loadSession(storage)).toBeNull()
  })

  it('reports failure when storage is missing, throws, or drops the write', () => {
    expect(saveSession({ token: 'tok', player }, null)).toBe(false)
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(saveSession({ token: 'tok', player }, throwing)).toBe(false)
    expect(loadSession(throwing)).toBeNull()
    expect(() => clearSession(throwing)).not.toThrow()
    const dropping: StorageLike = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
    expect(saveSession({ token: 'tok', player }, dropping)).toBe(false)
    expect(loadSession(memoryStorage({ [SESSION_STORAGE_KEY]: '{oops' }))).toBeNull()
  })
})
