import { backendUrl } from '../backend'
import type { AvatarId, CustomAvatarId } from './types'
import { isCustomAvatarId } from './validation'

export type AvatarDefinition = {
  id: AvatarId
  label: string
  glyph?: string
  image?: string
  color: string
  /** An uploaded photo-like image rather than a pixel sprite. */
  custom?: boolean
}

/** Fixed, clearly distinguishable avatar set; every one is free. The server lets one connected player hold each at a time. */
export const AVATARS: readonly AvatarDefinition[] = [
  { id: 'ember', label: 'Ember flame', glyph: '✦', color: '#ff9f6b' },
  { id: 'tide', label: 'Tide wave', glyph: '≈', color: '#6fd3ff' },
  { id: 'moss', label: 'Moss leaf', glyph: '❦', color: '#d9ff9a' },
  { id: 'dune', label: 'Dune sun', glyph: '☀', color: '#ffd76b' },
  { id: 'frost', label: 'Frost crystal', glyph: '❄', color: '#d6e8ff' },
  { id: 'ash', label: 'Ash ring', glyph: '◎', color: '#c6b8d8' },
  { id: 'dog', label: 'Pixel dog', image: '/avatars/dog.png', color: '#d98947' },
  { id: 'clown', label: 'Pixel clown', image: '/avatars/clown.png', color: '#ff5d5d' },
  { id: 'shark', label: 'Pixel shark', image: '/avatars/shark.png', color: '#58b7ff' },
  { id: 'toilet', label: 'Pixel toilet', image: '/avatars/toilet.png', color: '#dbeaff' },
  { id: 'hot-dog', label: 'Mustard hot dog', image: '/avatars/hot-dog.png', color: '#ffd52e' },
  { id: 'cowboy-hat', label: 'Tall cowboy hat', image: '/avatars/cowboy-hat.png', color: '#d89a5b' },
  { id: 'cleopatra', label: 'Cleopatra', image: '/avatars/cleopatra.png', color: '#ffd24a' },
  { id: 'julius-caesar', label: 'Julius Caesar', image: '/avatars/julius-caesar.png', color: '#5aa83a' },
  { id: 'genghis-khan', label: 'Genghis Khan', image: '/avatars/genghis-khan.png', color: '#d8433b' },
  { id: 'joan-of-arc', label: 'Joan of Arc', image: '/avatars/joan-of-arc.png', color: '#9aa0a8' },
  { id: 'leonardo-da-vinci', label: 'Leonardo da Vinci', image: '/avatars/leonardo-da-vinci.png', color: '#e8e8ee' },
  { id: 'william-shakespeare', label: 'William Shakespeare', image: '/avatars/william-shakespeare.png', color: '#f4f1ea' },
  { id: 'galileo-galilei', label: 'Galileo Galilei', image: '/avatars/galileo-galilei.png', color: '#9aa0a8' },
  { id: 'isaac-newton', label: 'Isaac Newton', image: '/avatars/isaac-newton.png', color: '#d8433b' },
  { id: 'napoleon-bonaparte', label: 'Napoleon Bonaparte', image: '/avatars/napoleon-bonaparte.png', color: '#3b5bd8' },
  { id: 'ada-lovelace', label: 'Ada Lovelace', image: '/avatars/ada-lovelace.png', color: '#8e5bd8' },
  { id: 'abraham-lincoln', label: 'Abraham Lincoln', image: '/avatars/abraham-lincoln.png', color: '#9aa0a8' },
  { id: 'harriet-tubman', label: 'Harriet Tubman', image: '/avatars/harriet-tubman.png', color: '#d8433b' },
  { id: 'robot', label: 'Robot', image: '/avatars/robot.png', color: '#9fd8ff' },
  { id: 'dragon', label: 'Dragon', image: '/avatars/dragon.png', color: '#7be07a' },
  { id: 'crown', label: 'Crown', image: '/avatars/crown.png', color: '#ffd447' },
  { id: 'ghost', label: 'Ghost', image: '/avatars/ghost.png', color: '#dfe8ff' },
  { id: 'cat', label: 'Cat', image: '/avatars/cat.png', color: '#f0a35e' },
  { id: 'alien', label: 'Alien', image: '/avatars/alien.png', color: '#8cf58c' },
  { id: 'wizard', label: 'Wizard', image: '/avatars/wizard.png', color: '#b18cff' },
  { id: 'skull', label: 'Skull', image: '/avatars/skull.png', color: '#f2f2e6' },
]

export const CUSTOM_AVATAR_LABEL = 'Uploaded image'

export function customAvatar(id: CustomAvatarId): AvatarDefinition {
  return { id, label: CUSTOM_AVATAR_LABEL, image: backendUrl(`/avatars/${id}`), color: '#d9ff9a', custom: true }
}

export function getAvatar(id: AvatarId): AvatarDefinition {
  if (isCustomAvatarId(id)) return customAvatar(id)
  return AVATARS.find((avatar) => avatar.id === id) ?? AVATARS[0]
}

/** The account's own upload first, then every built-in avatar. */
export function selectableAvatars(custom: CustomAvatarId | null = null): readonly AvatarDefinition[] {
  return [...(custom ? [customAvatar(custom)] : []), ...AVATARS]
}
