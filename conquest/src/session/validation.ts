import { AVATAR_IDS, type AuthFieldErrors, type AuthInput, type AvatarId, type BuiltInAvatarId, type CustomAvatarId } from './types'

export const NAME_MAX_LENGTH = 24
export const PIN_LENGTH = 4
const PIN_PATTERN = /^\d{4}$/

export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

const CUSTOM_AVATAR_PATTERN = /^custom-[0-9a-f]{32}-[0-9a-f]{8}$/

export function isBuiltInAvatarId(value: unknown): value is BuiltInAvatarId {
  return typeof value === 'string' && (AVATAR_IDS as readonly string[]).includes(value)
}

export function isCustomAvatarId(value: unknown): value is CustomAvatarId {
  return typeof value === 'string' && CUSTOM_AVATAR_PATTERN.test(value)
}

export function isAvatarId(value: unknown): value is AvatarId {
  return isBuiltInAvatarId(value) || isCustomAvatarId(value)
}

export function isValidPin(value: string): boolean {
  return PIN_PATTERN.test(value)
}

/** Client-side checks mirroring the backend's; the backend remains authoritative. */
export function validateAuthInput(input: AuthInput): AuthFieldErrors {
  const errors: AuthFieldErrors = {}
  const name = normalizeName(input.name)

  if (name.length === 0) {
    errors.name = 'Enter a name to continue.'
  } else if (name.length > NAME_MAX_LENGTH) {
    errors.name = `Names can be at most ${NAME_MAX_LENGTH} characters.`
  }

  if (!isValidPin(input.pin)) {
    errors.pin = `Enter a ${PIN_LENGTH}-digit PIN.`
  }

  if (input.mode === 'register') {
    if (input.avatar === 'custom') {
      if (!input.customImage) errors.avatar = 'Upload and crop an image, or choose an avatar.'
    } else if (!isBuiltInAvatarId(input.avatar)) {
      errors.avatar = 'Choose an avatar to continue.'
    }
  }

  return errors
}
