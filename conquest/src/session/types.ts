/**
 * Every built-in avatar is free: selectable at registration and by every
 * account. Launch set, historical figures, then the former shop set; mirrors
 * the backend `AVATARS` order.
 */
export const AVATAR_IDS = [
  'ember', 'tide', 'moss', 'dune', 'frost', 'ash',
  'dog', 'clown', 'shark', 'toilet', 'hot-dog', 'cowboy-hat',
  'cleopatra', 'julius-caesar', 'genghis-khan', 'joan-of-arc', 'leonardo-da-vinci', 'william-shakespeare',
  'galileo-galilei', 'isaac-newton', 'napoleon-bonaparte', 'ada-lovelace', 'abraham-lincoln', 'harriet-tubman',
  'robot', 'dragon', 'crown', 'ghost', 'cat', 'alien', 'wizard', 'skull',
] as const

export type BuiltInAvatarId = (typeof AVATAR_IDS)[number]
/** An account-private uploaded image: `custom-<owner id hex>-<upload version>`. */
export type CustomAvatarId = `custom-${string}`
export type AvatarId = BuiltInAvatarId | CustomAvatarId

/** Public player record as returned by the backend. */
export type Player = {
  id: string
  name: string
  avatar: AvatarId
  /** This account's current uploaded image, selectable only by its owner. */
  customAvatar: CustomAvatarId | null
  createdAt: number
  lastSeenAt: number
}

export type AuthMode = 'register' | 'login'

/** A cropped image ready to send: base64 `data` plus a local preview URL. */
export type AvatarUpload = {
  contentType: string
  data: string
  previewUrl: string
}

/** Registration choice: a built-in avatar, or `custom` with the prepared upload. */
export type AvatarChoice = AvatarId | 'custom'

export type AuthInput = {
  mode: AuthMode
  name: string
  pin: string
  avatar: AvatarChoice | null
  customImage?: AvatarUpload | null
}

export type AuthFieldErrors = {
  name?: string
  pin?: string
  avatar?: string
  form?: string
}
