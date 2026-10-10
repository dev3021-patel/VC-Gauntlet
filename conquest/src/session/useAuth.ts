import { useCallback, useEffect, useState } from 'react'
import { ApiError, fetchCurrentPlayer, loginPlayer, registerPlayer } from './api'
import { clearSession, loadSession, saveSession, type StorageLike } from './storage'
import type { AuthFieldErrors, AuthInput, AvatarChoice, Player } from './types'
import { normalizeName } from './validation'

export type AuthState =
  | { status: 'restoring'; player: Player; token: string }
  | { status: 'signed-out'; player: null; token: null }
  | { status: 'signed-in'; player: Player; token: string }

export type AuthDeps = {
  storage?: StorageLike | null
  fetchImpl?: typeof fetch
}

const SAVE_FAILED = 'This browser could not save your session. Check storage settings or private mode, then try again.'
const OFFLINE = 'Could not reach the server. Check your connection and try again.'

/**
 * Restores a stored token by asking the backend for the current player. A
 * rejected token clears the session; a network failure keeps the last known
 * player so a flaky connection never signs anyone out.
 */
export function useAuth({ storage, fetchImpl }: AuthDeps = {}): AuthState & {
  submit: (input: AuthInput) => Promise<AuthFieldErrors>
  updatePlayer: (player: Player) => void
} {
  const load = () => loadSession(storage)
  const save = (session: { token: string; player: Player }) => saveSession(session, storage)
  const clear = () => clearSession(storage)

  const [state, setState] = useState<AuthState>(() => {
    const stored = load()
    return stored
      ? { status: 'restoring', player: stored.player, token: stored.token }
      : { status: 'signed-out', player: null, token: null }
  })

  useEffect(() => {
    const stored = load()
    if (!stored) return
    let cancelled = false
    fetchCurrentPlayer(stored.token, fetchImpl)
      .then((player) => {
        if (cancelled) return
        save({ token: stored.token, player })
        setState({ status: 'signed-in', player, token: stored.token })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          clear()
          setState({ status: 'signed-out', player: null, token: null })
        } else {
          setState({ status: 'signed-in', player: stored.player, token: stored.token })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = useCallback(
    async (input: AuthInput): Promise<AuthFieldErrors> => {
      const name = normalizeName(input.name)
      try {
        const result =
          input.mode === 'register'
            ? await registerPlayer({ name, pin: input.pin, avatar: input.avatar as AvatarChoice, customImage: input.customImage }, fetchImpl)
            : await loginPlayer({ name, pin: input.pin }, fetchImpl)
        if (!save(result)) return { form: SAVE_FAILED }
        setState({ status: 'signed-in', player: result.player, token: result.token })
        return {}
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.code === 'name-taken') return { name: error.message }
          if (error.code.startsWith('name-')) return { name: error.message }
          if (error.code.startsWith('pin-')) return { pin: error.message }
          if (error.code.startsWith('avatar-')) return { avatar: error.message }
          return { form: error.message }
        }
        return { form: OFFLINE }
      }
    },
    [fetchImpl, storage],
  )

  const updatePlayer = useCallback((player: Player) => {
    if (state.status !== 'signed-in') return
    save({ token: state.token, player })
    setState({ ...state, player })
  }, [state, storage])

  return { ...state, submit, updatePlayer }
}
