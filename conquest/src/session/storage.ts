import type { Player } from './types'
import { isAvatarId, isCustomAvatarId, normalizeName } from './validation'

export const SESSION_STORAGE_KEY = 'party-conquest.session'
export const SESSION_STORAGE_VERSION = 2

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type StoredSession = {
  token: string
  player: Player
}

export function serializeSession(session: StoredSession): string {
  return JSON.stringify({ version: SESSION_STORAGE_VERSION, ...session })
}

export function parsePlayer(value: unknown): Player | null {
  if (typeof value !== 'object' || value === null) return null
  const player = value as Partial<Player>
  if (typeof player.id !== 'string' || player.id.length === 0) return null
  if (typeof player.name !== 'string' || normalizeName(player.name).length === 0) return null
  if (!isAvatarId(player.avatar)) return null
  return {
    id: player.id,
    name: normalizeName(player.name),
    avatar: player.avatar,
    customAvatar: isCustomAvatarId(player.customAvatar) ? player.customAvatar : null,
    createdAt: typeof player.createdAt === 'number' ? player.createdAt : 0,
    lastSeenAt: typeof player.lastSeenAt === 'number' ? player.lastSeenAt : 0,
  }
}

/** Missing, malformed, or wrong-version data yields `null` so the auth modal shows. */
export function parseStoredSession(raw: string | null | undefined): StoredSession | null {
  if (typeof raw !== 'string' || raw.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as { version?: unknown; token?: unknown; player?: unknown }
  if (record.version !== SESSION_STORAGE_VERSION) return null
  if (typeof record.token !== 'string' || record.token.length === 0) return null
  const player = parsePlayer(record.player)
  return player ? { token: record.token, player } : null
}

export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadSession(storage: StorageLike | null = browserStorage()): StoredSession | null {
  try {
    return parseStoredSession(storage?.getItem(SESSION_STORAGE_KEY))
  } catch {
    return null
  }
}

/** Returns false when the browser refuses or drops the write. */
export function saveSession(session: StoredSession, storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false
  try {
    const serialized = serializeSession(session)
    storage.setItem(SESSION_STORAGE_KEY, serialized)
    return storage.getItem(SESSION_STORAGE_KEY) === serialized
  } catch {
    return false
  }
}

export function clearSession(storage: StorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // Nothing else to do; the modal will show on next load regardless.
  }
}
