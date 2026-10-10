import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { AVATARS, CUSTOM_AVATAR_LABEL } from '../session/avatars'
import type { AuthFieldErrors, AuthInput, AuthMode, AvatarChoice, AvatarUpload } from '../session/types'
import { NAME_MAX_LENGTH, PIN_LENGTH, validateAuthInput } from '../session/validation'
import { useAvatarAvailability } from '../useAvatarAvailability'
import { DEFAULT_WORLD_ID } from '../worldSync'
import { AvatarPickerGrid, type AvatarPickerOption } from './AvatarPickerGrid'
import { CustomAvatarUpload } from './CustomAvatarUpload'

/**
 * Opt-out attributes honored by password-manager extensions (LastPass,
 * 1Password, Bitwarden) and generic form fillers. Brave's browser-process
 * autofill engaging on this form has been linked to full-browser crashes.
 */
export const AUTOFILL_OPT_OUT = {
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const

type AuthModalProps = {
  /** Resolves with field errors to show, or an empty object on success. */
  onSubmit: (input: AuthInput) => Promise<AuthFieldErrors>
  /** World whose connected players make built-in avatars unavailable. */
  worldId?: string
  fetchImpl?: typeof fetch
}

const AVATAR_TAKEN = 'Another player is using that avatar right now. Choose a different one.'

export function AuthModal({ onSubmit, worldId = DEFAULT_WORLD_ID, fetchImpl }: AuthModalProps) {
  const baseId = useId()
  // Non-semantic ids and field names keep browser autofill heuristics (which
  // ignore autocomplete="off") from classifying these as name/credential fields.
  const nameId = `${baseId}-field-a`
  const pinId = `${baseId}-field-b`
  const nameErrorId = `${baseId}-name-error`
  const pinErrorId = `${baseId}-pin-error`
  const avatarErrorId = `${baseId}-avatar-error`

  const nameRef = useRef<HTMLInputElement>(null)
  const pinRef = useRef<HTMLInputElement>(null)
  const avatarGroupRef = useRef<HTMLFieldSetElement>(null)
  const [mode, setMode] = useState<AuthMode>('register')
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [avatar, setAvatar] = useState<AvatarChoice | null>(null)
  const [customImage, setCustomImage] = useState<AvatarUpload | null>(null)
  const [errors, setErrors] = useState<AuthFieldErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const availability = useAvatarAvailability(worldId, mode === 'register', null, fetchImpl)
  const avatarOptions: AvatarPickerOption[] = [
    ...(customImage ? [{ value: 'custom' as const, label: CUSTOM_AVATAR_LABEL, previewUrl: customImage.previewUrl }] : []),
    ...AVATARS.map(({ id, label }) => ({ value: id, label })),
  ]
  const avatarInUse = (value: AvatarChoice) => value !== 'custom' && availability.inUse(value)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const focusFirstError = (fieldErrors: AuthFieldErrors) => {
    if (fieldErrors.name) nameRef.current?.focus()
    else if (fieldErrors.pin) pinRef.current?.focus()
    else if (fieldErrors.avatar) avatarGroupRef.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus()
  }

  const switchMode = (next: AuthMode) => {
    setMode(next)
    setErrors({})
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input: AuthInput = { mode, name, pin, avatar, ...(mode === 'register' && avatar === 'custom' ? { customImage } : {}) }
    const local = validateAuthInput(input)
    if (mode === 'register' && avatar && avatarInUse(avatar) && !local.avatar) local.avatar = AVATAR_TAKEN
    if (Object.keys(local).length > 0) {
      setErrors(local)
      focusFirstError(local)
      return
    }

    setSubmitting(true)
    const remote = await onSubmit(input)
    setSubmitting(false)
    if (Object.keys(remote).length > 0) {
      // Entered values are preserved so the player only changes what was rejected.
      setErrors(remote)
      focusFirstError(remote)
      if (remote.avatar) availability.refresh()
    }
  }

  const isRegister = mode === 'register'

  return (
    <div className="register-backdrop">
      <section className="register-modal" role="dialog" aria-modal="true" aria-labelledby={`${baseId}-title`}>
        <header className="register-header">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">The shared frontier</p>
            <h2 id={`${baseId}-title`}>{isRegister ? 'Join Party Conquest' : 'Welcome back'}</h2>
          </div>
        </header>

        <div className="mode-switch" role="tablist" aria-label="Sign-in mode">
          <button
            type="button"
            role="tab"
            aria-selected={isRegister}
            className={isRegister ? 'is-active' : undefined}
            onClick={() => switchMode('register')}
          >
            New player
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isRegister}
            className={!isRegister ? 'is-active' : undefined}
            onClick={() => switchMode('login')}
          >
            Returning player
          </button>
        </div>

        <p className="register-lede">
          {isRegister
            ? 'Pick a name, an avatar, and a 4-digit PIN. Use them to return to your world from any device.'
            : 'Enter the name and 4-digit PIN you signed up with to pick up where you left off.'}
        </p>

        <form className="register-form" onSubmit={submit} noValidate autoComplete="off">
          <div className="field">
            <label htmlFor={nameId}>Name</label>
            <input
              ref={nameRef}
              id={nameId}
              name="field-a"
              type="text"
              autoComplete="off"
              {...AUTOFILL_OPT_OUT}
              autoCapitalize="off"
              spellCheck={false}
              maxLength={NAME_MAX_LENGTH + 8}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                if (errors.name || errors.form) setErrors({ ...errors, name: undefined, form: undefined })
              }}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? nameErrorId : undefined}
              placeholder="e.g. Marlowe"
            />
            {errors.name && (
              <p id={nameErrorId} className="field-error" role="alert">
                {errors.name}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor={pinId}>4-digit PIN</label>
            <input
              ref={pinRef}
              id={pinId}
              name="field-b"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              {...AUTOFILL_OPT_OUT}
              maxLength={PIN_LENGTH}
              value={pin}
              onChange={(event) => {
                setPin(event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))
                if (errors.pin || errors.form) setErrors({ ...errors, pin: undefined, form: undefined })
              }}
              aria-invalid={errors.pin ? true : undefined}
              aria-describedby={errors.pin ? pinErrorId : undefined}
              placeholder="••••"
              className="pin-input"
            />
            {errors.pin && (
              <p id={pinErrorId} className="field-error" role="alert">
                {errors.pin}
              </p>
            )}
          </div>

          {isRegister && (
            <fieldset
              ref={avatarGroupRef}
              className="field avatar-field"
              aria-invalid={errors.avatar ? true : undefined}
              aria-describedby={errors.avatar ? avatarErrorId : undefined}
            >
              <legend>Avatar</legend>
              <AvatarPickerGrid
                name="avatar"
                options={avatarOptions}
                selected={avatar}
                inUse={avatarInUse}
                onSelect={(value) => {
                  setAvatar(value)
                  if (errors.avatar) setErrors({ ...errors, avatar: undefined })
                }}
              />
              <CustomAvatarUpload
                disabled={submitting}
                onReady={async (upload) => {
                  setCustomImage(upload)
                  setAvatar('custom')
                  if (errors.avatar) setErrors({ ...errors, avatar: undefined })
                  return null
                }}
              />
              {errors.avatar && (
                <p id={avatarErrorId} className="field-error" role="alert">
                  {errors.avatar}
                </p>
              )}
            </fieldset>
          )}

          {errors.form && (
            <p className="notice notice-error" role="alert">
              {errors.form}
            </p>
          )}

          <button type="submit" className="primary-button" disabled={submitting}>
            {submitting ? 'One moment…' : isRegister ? 'Create and enter' : 'Sign in'}
          </button>

          <p className="register-footnote">
            {isRegister
              ? 'Your PIN is the only key to this name. There is no reset, so pick one you will remember.'
              : 'Names are matched without regard to case.'}
          </p>
        </form>
      </section>
    </div>
  )
}
