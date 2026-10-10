import type { Ref } from 'react'
import type { AvatarChoice, AvatarId } from '../session/types'
import { Avatar } from './Avatar'

export type AvatarPickerOption = { value: AvatarChoice; label: string; previewUrl?: string }

/**
 * Radio grid shared by registration and the in-game picker. It scrolls inside
 * `.avatar-grid-scroll` so the surrounding title, errors, and actions stay put.
 * Avatars held by another connected player are disabled and labelled "In use".
 */
export function AvatarPickerGrid({ name, options, selected, onSelect, inUse, focusValue, focusRef }: {
  name: string
  options: readonly AvatarPickerOption[]
  selected: AvatarChoice | null
  onSelect: (value: AvatarChoice) => void
  inUse: (value: AvatarChoice) => boolean
  /** The option that receives `focusRef`, for initial focus. */
  focusValue?: AvatarChoice | null
  focusRef?: Ref<HTMLInputElement>
}) {
  return (
    <div className="avatar-grid-scroll">
      <div className="avatar-grid">
        {options.map((option) => {
          const taken = inUse(option.value)
          return (
            <label key={option.value} className={`avatar-option${taken ? ' avatar-option--in-use' : ''}`}>
              <input
                ref={option.value === focusValue ? focusRef : undefined}
                type="radio"
                name={name}
                value={option.value}
                checked={selected === option.value}
                disabled={taken}
                onChange={() => onSelect(option.value)}
              />
              {option.previewUrl !== undefined
                ? <Avatar previewUrl={option.previewUrl} size="lg" />
                : <Avatar id={option.value as AvatarId} size="lg" />}
              <span className="avatar-option-label">{option.label}</span>
              {taken && <>{' '}<span className="avatar-option-status">In use</span></>}
            </label>
          )
        })}
      </div>
    </div>
  )
}
