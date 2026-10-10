import type { PointerEvent as ReactPointerEvent } from 'react'
import type { MoveDirection } from '../playerPosition'

export type VirtualControlsProps = {
  disabled: boolean
  onMoveStart: (direction: MoveDirection) => void
  onMoveEnd: (direction: MoveDirection) => void
  onFire: () => void
  /** The laser is recharging: FIRE stays pressable but reads as not ready. */
  fireRecharging?: boolean
}

const DIRECTIONS: { direction: MoveDirection; label: string; glyph: string; area: string }[] = [
  { direction: 'north', label: 'Move up', glyph: '▲', area: 'north' },
  { direction: 'west', label: 'Move left', glyph: '◀', area: 'west' },
  { direction: 'east', label: 'Move right', glyph: '▶', area: 'east' },
  { direction: 'south', label: 'Move down', glyph: '▼', area: 'south' },
]

/**
 * On-screen thumb controls for touch devices. Movement buttons feed the same
 * held-movement path as the keyboard: press starts, release/cancel/slide-off
 * stops. FIRE is the touch equivalent of Space.
 */
export function VirtualControls({ disabled, onMoveStart, onMoveEnd, onFire, fireRecharging = false }: VirtualControlsProps) {
  const stopContextMenu = (event: { preventDefault: () => void }) => event.preventDefault()

  const movementHandlers = (direction: MoveDirection) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      // Prevent focus, scroll, and synthetic mouse events so a thumb press never pans the map.
      event.preventDefault()
      if (disabled || event.button > 0) return
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* capture is best-effort */ }
      }
      onMoveStart(direction)
    },
    onPointerUp: () => onMoveEnd(direction),
    onPointerCancel: () => onMoveEnd(direction),
    onLostPointerCapture: () => onMoveEnd(direction),
    onContextMenu: stopContextMenu,
  })

  return (
    <div className="virtual-controls" role="group" aria-label="Touch controls">
      <div className="virtual-dpad" role="group" aria-label="Movement">
        {DIRECTIONS.map(({ direction, label, glyph, area }) => (
          <button
            key={direction}
            type="button"
            className={`virtual-dpad-${area}`}
            aria-label={label}
            disabled={disabled}
            {...movementHandlers(direction)}
          ><span aria-hidden="true">{glyph}</span></button>
        ))}
      </div>
      <div className="virtual-actions" role="group" aria-label="Actions">
        <button type="button" className={`virtual-action-fire${fireRecharging ? ' virtual-action-fire--recharging' : ''}`} aria-label="Fire" data-recharging={fireRecharging || undefined} disabled={disabled} onClick={onFire} onContextMenu={stopContextMenu}>
          <span aria-hidden="true">FIRE</span>
        </button>
      </div>
    </div>
  )
}
