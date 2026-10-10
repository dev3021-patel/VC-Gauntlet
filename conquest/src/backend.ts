/** Explicit backend override; standalone builds default to the local backend. */
export const LOCAL_BACKEND_URL = 'http://localhost:8000'

export type BackendEnv = {
  VITE_BACKEND_URL?: string
  DEV?: boolean
}

export function resolveBackendUrl(env: BackendEnv): string {
  const override = env.VITE_BACKEND_URL?.trim()
  if (override) return override.replace(/\/+$/, '')
  return LOCAL_BACKEND_URL
}

export const BACKEND_URL = resolveBackendUrl(import.meta.env)

export function backendUrl(path: string): string {
  return `${BACKEND_URL}${path.startsWith('/') ? path : `/${path}`}`
}

export type BackendHealth = {
  status: string
  service: string
  version: string
}

export async function fetchBackendHealth(signal?: AbortSignal): Promise<BackendHealth> {
  const response = await fetch(backendUrl('/healthz'), { signal })
  if (!response.ok) throw new Error(`Backend health check failed with HTTP ${response.status}`)
  return (await response.json()) as BackendHealth
}
