import { backendUrl } from '../backend'
import { parsePlayer } from './storage'
import type { AvatarChoice, AvatarUpload, Player } from './types'

export type AuthResponse = { token: string; player: Player }

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type FetchLike = typeof fetch

async function request(path: string, init: RequestInit, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(backendUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (response.status === 204) return null
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null
  if (!response.ok) {
    throw new ApiError(response.status, body?.error ?? 'request-failed', body?.message ?? `Request failed (${response.status}).`)
  }
  return body
}

function toAuthResponse(body: unknown): AuthResponse {
  const record = body as { token?: unknown; player?: unknown } | null
  const player = parsePlayer(record?.player)
  if (!player || typeof record?.token !== 'string') throw new ApiError(502, 'bad-response', 'Unexpected reply from the server.')
  return { token: record.token, player }
}

function uploadBody({ contentType, data }: AvatarUpload) {
  return { contentType, data }
}

export function registerPlayer(
  input: { name: string; pin: string; avatar: AvatarChoice; customImage?: AvatarUpload | null },
  fetchImpl: FetchLike = fetch,
) {
  const { customImage, ...fields } = input
  const body = input.avatar === 'custom' && customImage ? { ...fields, customAvatar: uploadBody(customImage) } : fields
  return request('/players/register', { method: 'POST', body: JSON.stringify(body) }, fetchImpl).then(toAuthResponse)
}

/** Stores or replaces this account's uploaded avatar; resolves with the refreshed account. */
export async function uploadCustomAvatar(token: string, upload: AvatarUpload, fetchImpl: FetchLike = fetch): Promise<Player> {
  const body = (await request('/players/me/custom-avatar', {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(uploadBody(upload)),
  }, fetchImpl)) as { player?: unknown } | null
  const player = parsePlayer(body?.player)
  if (!player?.customAvatar) throw new ApiError(502, 'bad-response', 'Unexpected reply from the server.')
  return player
}

/** Built-in avatars held by connected players in a world, keyed by avatar ID with the holder's player ID. */
export async function fetchAvatarsInUse(worldId: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<Record<string, string>> {
  const body = (await request(`/v1/worlds/${encodeURIComponent(worldId)}/avatars`, { method: 'GET', signal }, fetchImpl)) as {
    inUse?: unknown
  } | null
  const held: Record<string, string> = {}
  if (Array.isArray(body?.inUse)) {
    for (const item of body.inUse as { avatar?: unknown; playerId?: unknown }[]) {
      if (typeof item?.avatar === 'string' && typeof item.playerId === 'string') held[item.avatar] = item.playerId
    }
  }
  return held
}

export function loginPlayer(input: { name: string; pin: string }, fetchImpl: FetchLike = fetch) {
  return request('/players/login', { method: 'POST', body: JSON.stringify(input) }, fetchImpl).then(toAuthResponse)
}

export async function fetchCurrentPlayer(token: string, fetchImpl: FetchLike = fetch): Promise<Player> {
  const body = (await request('/players/me', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, fetchImpl)) as {
    player?: unknown
  } | null
  const player = parsePlayer(body?.player)
  if (!player) throw new ApiError(502, 'bad-response', 'Unexpected reply from the server.')
  return player
}
