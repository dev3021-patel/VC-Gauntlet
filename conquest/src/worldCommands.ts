import { backendUrl } from './backend'
import { ApiError } from './session/api'
import { WORLD_PROTOCOL_VERSION, WORLD_SCHEMA_VERSION, type WorldEvent } from './worldSync'

export type WorldCommandResult = { event: WorldEvent }

export function commandId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

export async function submitWorldCommand(
  fetchImpl: typeof fetch,
  worldId: string,
  token: string,
  actionType: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  id = commandId(),
): Promise<WorldCommandResult> {
  const response = await fetchImpl(backendUrl(`/v1/worlds/${encodeURIComponent(worldId)}/commands`), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ protocolVersion: WORLD_PROTOCOL_VERSION, schemaVersion: WORLD_SCHEMA_VERSION, worldId, commandId: id, actionType, payload }),
  })
  const body = await response.json().catch(() => ({})) as { event?: WorldEvent; error?: { code?: string; message?: string } }
  if (!response.ok || !body.event) {
    throw new ApiError(
      response.status,
      body.error?.code ?? 'position-command-failed',
      body.error?.message ?? `Position command failed (${response.status})`,
    )
  }
  return { event: body.event }
}
