import type { StorageLike } from './session/storage'

/** Device-local: a new device shows the panel again. Bump the version when the controls change. */
export const HOW_TO_PLAY_KEY = 'party-conquest.how-to-play'
export const HOW_TO_PLAY_VERSION = 4
/** How long the dock button glows after the first-visit panel is dismissed. */
export const HOW_TO_PLAY_HIGHLIGHT_MS = 6000

/** True only when this device has a stored dismissal. Missing, malformed, or unreadable data shows the panel. */
export function hasSeenHowToPlay(storage: StorageLike | null): boolean {
  try {
    const raw = storage?.getItem(HOW_TO_PLAY_KEY)
    if (!raw) return false
    const saved = JSON.parse(raw) as { version?: unknown; dismissed?: unknown }
    return saved.version === HOW_TO_PLAY_VERSION && saved.dismissed === true
  } catch {
    return false
  }
}

export function markHowToPlaySeen(storage: StorageLike | null) {
  try {
    storage?.setItem(HOW_TO_PLAY_KEY, JSON.stringify({ version: HOW_TO_PLAY_VERSION, dismissed: true }))
  } catch { /* The panel still closes; it may reopen on the next load. */ }
}
