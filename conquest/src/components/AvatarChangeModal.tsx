import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { selectableAvatars } from '../session/avatars'
import type { AvatarId, AvatarUpload, CustomAvatarId } from '../session/types'
import { AvatarPickerGrid } from './AvatarPickerGrid'
import { CustomAvatarUpload } from './CustomAvatarUpload'

export function AvatarChangeModal({ current, custom = null, inUse = () => false, required = false, onSave, onUpload, onCancel }: {
  current: AvatarId
  /** This account's uploaded image, offered only to its owner. */
  custom?: CustomAvatarId | null
  /** Built-in avatars held by another connected player. */
  inUse?: (avatar: AvatarId) => boolean
  /** The saved avatar is taken: the player must choose before continuing, so it cannot be dismissed. */
  required?: boolean
  onSave: (avatar: AvatarId) => Promise<string | null>
  /** Stores a replacement upload and resolves with its avatar ID; rejects with a readable message. */
  onUpload?: (upload: AvatarUpload) => Promise<CustomAvatarId>
  onCancel: () => void
}) {
  const titleId = useId()
  const modalRef = useRef<HTMLElement>(null)
  const currentChoiceRef = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<AvatarId>(current)
  const [uploaded, setUploaded] = useState<CustomAvatarId | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ownCustom = uploaded ?? custom
  const selectedTaken = inUse(selected)
  const canSave = !saving && !selectedTaken && (required || selected !== current)
  const dismissible = !required && !saving

  useEffect(() => {
    const initial = currentChoiceRef.current
    if (initial && !initial.disabled) initial.focus()
    else modalRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:not(:disabled)')?.focus()
    // Initial focus only; later availability changes must not steal focus.
  }, [])

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (dismissible) onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      ) ?? [])
      if (!controls.length) return
      const first = controls[0]
      const last = controls.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', dismiss, true)
    return () => window.removeEventListener('keydown', dismiss, true)
  }, [dismissible, onCancel])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    setError(null)
    const message = await onSave(selected)
    if (message) {
      setError(message)
      setSaving(false)
    }
  }

  const upload = async (image: AvatarUpload) => {
    if (!onUpload) return 'Image uploads are unavailable right now.'
    try {
      const id = await onUpload(image)
      setUploaded(id)
      setSelected(id)
      setError(null)
      return null
    } catch (uploadError) {
      return uploadError instanceof Error ? uploadError.message : 'That image could not be saved. Try again.'
    }
  }

  const dismissBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && dismissible) onCancel()
  }

  return (
    <div className="avatar-modal-backdrop" onMouseDown={dismissBackdrop}>
      <section ref={modalRef} className="avatar-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <p className="eyebrow">Cosmetic loadout</p>
          <h2 id={titleId}>{required ? 'Choose another avatar' : 'Change avatar'}</h2>
          <p>{required
            ? 'Another player in this world is using your saved avatar. Pick an available one to continue.'
            : 'Pick a new look. Every avatar is free to switch to.'}</p>
        </header>
        <form onSubmit={submit}>
          <fieldset className="field avatar-field">
            <legend>Avatar</legend>
            <AvatarPickerGrid
              name="changed-avatar"
              options={selectableAvatars(ownCustom).map(({ id, label }) => ({ value: id, label }))}
              selected={selected}
              inUse={(value) => inUse(value as AvatarId)}
              focusValue={current}
              focusRef={currentChoiceRef}
              onSelect={(value) => { setSelected(value as AvatarId); setError(null) }}
            />
            {onUpload && <CustomAvatarUpload disabled={saving} onReady={upload} />}
          </fieldset>
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          <div className="avatar-modal-actions">
            {!required && <button type="button" className="secondary-button" disabled={saving} onClick={onCancel}>Cancel</button>}
            <button type="submit" className="primary-button" disabled={!canSave}>
              {saving ? 'Saving…' : 'Save avatar'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
