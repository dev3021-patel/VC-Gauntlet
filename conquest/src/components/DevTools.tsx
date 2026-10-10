import { useState } from 'react'
import { AVATARS } from '../session/avatars'
import type { AvatarId, Player } from '../session/types'

if (import.meta.env.DEV) void import('./devTools.css')

type DevToolsProps = {
  player: Player | null
  onMockPlayer: (player: Player | null) => void
}

let mockSequence = 0

export function DevTools({ player, onMockPlayer }: DevToolsProps) {
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState('Preview Player')
  const [avatar, setAvatar] = useState<AvatarId>('moss')

  return (
    <aside className="dev-tools">
      <button
        type="button"
        className="dev-tools-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span aria-hidden="true">⚙</span> Dev tools
      </button>
      {expanded && (
        <form
          className="dev-tools-panel"
          onSubmit={(event) => {
            event.preventDefault()
            const normalizedName = name.trim()
            if (!normalizedName) return
            const now = Date.now()
            mockSequence += 1
            onMockPlayer({
              id: `dev-player-${now}-${mockSequence}`,
              name: normalizedName,
              avatar,
              customAvatar: null,
              createdAt: now,
              lastSeenAt: now,
            })
          }}
        >
          <p>Local preview identity</p>
          <label>
            Name
            <input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Avatar
            <select value={avatar} onChange={(event) => setAvatar(event.target.value as AvatarId)}>
              {AVATARS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <button type="submit" className="dev-tools-action">Mock new player</button>
          {player && <button type="button" className="dev-tools-reset" onClick={() => onMockPlayer(null)}>Clear mock</button>}
        </form>
      )}
    </aside>
  )
}
