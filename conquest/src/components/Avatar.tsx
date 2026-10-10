import { CUSTOM_AVATAR_LABEL, getAvatar, type AvatarDefinition } from '../session/avatars'
import type { AvatarId } from '../session/types'

type AvatarProps = ({ id: AvatarId; previewUrl?: undefined } | {
  id?: undefined
  /** Local preview of a cropped upload that has no server ID yet. */
  previewUrl: string
}) & {
  size?: 'sm' | 'md' | 'lg'
  /** Set when the avatar stands alone; omit when adjacent text already names it. */
  labelled?: boolean
}

export function Avatar({ id, previewUrl, size = 'md', labelled = false }: AvatarProps) {
  const avatar: Omit<AvatarDefinition, 'id'> = previewUrl !== undefined
    ? { label: CUSTOM_AVATAR_LABEL, image: previewUrl, color: '#d9ff9a', custom: true }
    : getAvatar(id)
  return (
    <span
      className={`avatar avatar-${size}${avatar.image ? ' avatar--sprite' : ''}${avatar.custom ? ' avatar--custom' : ''}`}
      style={{ '--avatar-color': avatar.color } as React.CSSProperties}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? avatar.label : undefined}
      aria-hidden={labelled ? undefined : true}
    >
      {avatar.image ? <img src={avatar.image} alt="" draggable={false} /> : avatar.glyph}
    </span>
  )
}
