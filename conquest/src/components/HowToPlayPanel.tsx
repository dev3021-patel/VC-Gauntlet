import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { InputMode } from '../useInputMode'

/** Keys are joined with ` + ` (pressed together) unless `alternatives` lists interchangeable keys. */
type Control = readonly [keys: readonly string[], action: string, alternatives?: boolean]

export const KEYBOARD_CONTROLS: readonly Control[] = [
  [['WASD', 'Arrow keys'], 'Move', true],
  [['Shift'], 'Hold while moving to sprint at double speed'],
  [['R'], 'Taunt other players'],
  [['Space'], 'Fire your laser the way you face'],
]

export const MAP_CONTROLS: readonly Control[] = [
  [['Scroll'], 'Pan the map'],
  [['⌘/Ctrl', 'Scroll'], 'Zoom the map'],
]

export const TOUCH_CONTROLS: readonly Control[] = [
  [['▲ ◀ ▶ ▼'], 'Hold the arrow pad to move'],
  [['FIRE'], 'Fire your laser the way you face'],
  [['Rejoin'], 'Come back after you are defeated'],
  [['Drag'], 'Pan the map'],
  [['Pinch'], 'Zoom the map'],
]

function ControlList({ label, controls }: { label: string; controls: readonly Control[] }) {
  return (
    <dl className="how-to-play-controls" aria-label={label}>
      {controls.map(([keys, action, alternatives]) => (
        <div key={action} className="how-to-play-control">
          <dt>{keys.map((key, index) => <span key={key}>{index > 0 && (alternatives ? ' or ' : ' + ')}<kbd>{key}</kbd></span>)}</dt>
          <dd>{action}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Single-screen objective and controls reference. The parent owns the open state
 * and blocks gameplay input while it is shown; this component owns focus
 * containment and the Got it / close / Escape dismissals. `onClose` receives the
 * element that had focus before the panel took it, so the caller can restore it.
 * It renders into `document.body` because `.map-viewport` isolates its stacking
 * context and the sign-in dialog is a sibling of the map; the first-visit panel
 * must sit above both.
 */
export function HowToPlayPanel({ inputMode, onClose }: {
  inputMode: InputMode
  onClose: (returnFocus: HTMLElement | null) => void
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const takeFocus = () => {
      const active = document.activeElement
      if (active instanceof HTMLElement && panelRef.current?.contains(active)) return
      if (active instanceof HTMLElement && active !== document.body) returnFocusRef.current = active
      confirmRef.current?.focus({ preventScroll: true })
    }
    takeFocus()
    // Sibling dialogs (the sign-in form) focus their first field after this effect runs.
    const frame = window.requestAnimationFrame(takeFocus)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose(returnFocusRef.current)
        return
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])
      if (!controls.length) return
      const first = controls[0]
      const last = controls.at(-1)!
      const active = document.activeElement
      if (!panelRef.current?.contains(active)) {
        event.preventDefault()
        takeFocus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [onClose])

  return createPortal(
    <div className="how-to-play-backdrop">
      <section ref={panelRef} className="how-to-play-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="how-to-play-header">
          <div>
            <p className="eyebrow">New to the frontier?</p>
            <h2 id={titleId}>How to play</h2>
          </div>
          <button type="button" className="how-to-play-close" aria-label="Close How to play" onClick={() => onClose(returnFocusRef.current)}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="how-to-play-body">
          <section className="how-to-play-objective" aria-labelledby={`${titleId}-objective`}>
            <h3 id={`${titleId}-objective`}>Objective</h3>
            <p>
              Roam the shared world and battle other players and mobs. The world never resets,
              so if you fall, rejoin and keep going.
            </p>
            <p>
              Your laser fires instantly the way you last moved and hits the first player or mob in
              line. Trees, walls, water, and the map edge stop it, and it recharges for a second
              between shots. One hit defeats a player; mobs take 3.
              Violet mobs glow, then fire a rocket: step aside to dodge it.
            </p>
          </section>
          <section className="how-to-play-controls-section" aria-labelledby={`${titleId}-controls`}>
            <h3 id={`${titleId}-controls`}>Controls</h3>
            {/* Only this list scrolls; the header, objective, and footer stay put. */}
            <div className="how-to-play-controls-scroll" tabIndex={0} aria-label="Controls list">
              {inputMode === 'touch'
                ? <>
                  <ControlList label="Touch controls" controls={TOUCH_CONTROLS} />
                  <p className="how-to-play-note">Change avatar is in the Player actions button next to the pad.</p>
                </>
                : <>
                  <ControlList label="Keyboard controls" controls={KEYBOARD_CONTROLS} />
                  <h4>Map navigation</h4>
                  <ControlList label="Map navigation controls" controls={MAP_CONTROLS} />
                </>}
            </div>
          </section>
        </div>
        <footer className="how-to-play-footer">
          <p>Reopen this any time with <strong>How to play</strong> in the control dock.</p>
          <button ref={confirmRef} type="button" className="primary-button" onClick={() => onClose(returnFocusRef.current)}>Got it</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
