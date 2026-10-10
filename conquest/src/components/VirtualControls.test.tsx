// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VirtualControls, type VirtualControlsProps } from './VirtualControls'

afterEach(cleanup)

function renderPad(overrides: Partial<VirtualControlsProps> = {}) {
  const props: VirtualControlsProps = {
    disabled: false, onMoveStart: vi.fn(), onMoveEnd: vi.fn(), onFire: vi.fn(),
    ...overrides,
  }
  render(<VirtualControls {...props} />)
  return props
}

describe('VirtualControls', () => {
  it('starts held movement on press and stops on release, cancel, or lost capture', () => {
    const props = renderPad()
    const right = screen.getByRole('button', { name: 'Move right' })
    fireEvent.pointerDown(right, { pointerId: 1, button: 0 })
    expect(props.onMoveStart).toHaveBeenCalledWith('east')
    fireEvent.pointerUp(right, { pointerId: 1 })
    expect(props.onMoveEnd).toHaveBeenCalledWith('east')

    const up = screen.getByRole('button', { name: 'Move up' })
    fireEvent.pointerDown(up, { pointerId: 2, button: 0 })
    fireEvent.pointerCancel(up, { pointerId: 2 })
    expect(props.onMoveEnd).toHaveBeenLastCalledWith('north')

    const down = screen.getByRole('button', { name: 'Move down' })
    fireEvent.pointerDown(down, { pointerId: 3, button: 0 })
    fireEvent.lostPointerCapture(down, { pointerId: 3 })
    expect(props.onMoveEnd).toHaveBeenLastCalledWith('south')
    expect(props.onMoveStart).toHaveBeenCalledTimes(3)
  })

  it('does not start movement while disabled and never opens a context menu', () => {
    const props = renderPad({ disabled: true })
    const left = screen.getByRole('button', { name: 'Move left' })
    fireEvent.pointerDown(left, { pointerId: 1, button: 0 })
    expect(props.onMoveStart).not.toHaveBeenCalled()
    const menu = fireEvent.contextMenu(left)
    expect(menu).toBe(false)
    expect((screen.getByRole('button', { name: 'Fire' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers FIRE as the only action', () => {
    const props = renderPad()
    const actions = screen.getByRole('group', { name: 'Actions' })
    expect(Array.from(actions.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'))).toEqual(['Fire'])
    fireEvent.click(screen.getByRole('button', { name: 'Fire' }))
    expect(props.onFire).toHaveBeenCalledTimes(1)
  })
})
