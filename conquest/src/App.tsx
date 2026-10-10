import { useState } from 'react'
import { AuthModal } from './components/AuthModal'
import { DevTools } from './components/DevTools'
import { MapCanvas } from './components/MapCanvas'
import { useAuth, type AuthDeps } from './session/useAuth'
import type { Player } from './session/types'

/** `storage` and `fetchImpl` are injected in tests; production uses localStorage and fetch. */
export function App(deps: AuthDeps = {}) {
  const auth = useAuth(deps)
  const [mockPlayer, setMockPlayer] = useState<Player | null>(null)
  const authenticatedPlayer = auth.status === 'signed-in' ? auth.player : null
  const activePlayer = import.meta.env.DEV ? mockPlayer ?? authenticatedPlayer : authenticatedPlayer
  const token = !mockPlayer && auth.status === 'signed-in' ? auth.token : null

  return (
    <main className="game-shell">
      <MapCanvas
        player={activePlayer}
        token={token}
        syncDeps={deps}
        onPlayerChange={auth.updatePlayer}
      />
      {auth.status === 'signed-out' && !mockPlayer && <AuthModal onSubmit={auth.submit} fetchImpl={deps.fetchImpl} />}
      {import.meta.env.DEV && <DevTools player={mockPlayer} onMockPlayer={setMockPlayer} />}
    </main>
  )
}
