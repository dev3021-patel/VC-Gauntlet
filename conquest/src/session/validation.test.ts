import { describe, expect, it } from 'vitest'
import { NAME_MAX_LENGTH, isAvatarId, isCustomAvatarId, isValidPin, normalizeName, validateAuthInput } from './validation'
import { AVATARS, CUSTOM_AVATAR_LABEL, getAvatar, selectableAvatars } from './avatars'
import { AVATAR_IDS } from './types'

it('defines all thirty-two avatars as one free catalog in order', () => {
  expect(AVATAR_IDS).toEqual([
    'ember', 'tide', 'moss', 'dune', 'frost', 'ash',
    'dog', 'clown', 'shark', 'toilet', 'hot-dog', 'cowboy-hat',
    'cleopatra', 'julius-caesar', 'genghis-khan', 'joan-of-arc', 'leonardo-da-vinci', 'william-shakespeare',
    'galileo-galilei', 'isaac-newton', 'napoleon-bonaparte', 'ada-lovelace', 'abraham-lincoln', 'harriet-tubman',
    'robot', 'dragon', 'crown', 'ghost', 'cat', 'alien', 'wizard', 'skull',
  ])
  expect(AVATARS.map(({ id }) => id)).toEqual(AVATAR_IDS)
  expect(AVATARS.some((avatar) => 'price' in avatar)).toBe(false)
  expect(AVATARS.slice(0, 6).every(({ glyph, image }) => glyph && !image)).toBe(true)
  expect(AVATARS.slice(6).every(({ image }) => image?.endsWith('.png'))).toBe(true)
})

it('offers every avatar to every account', () => {
  expect(selectableAvatars().map(({ id }) => id)).toEqual(AVATAR_IDS)
  expect(getAvatar('skull').image).toBe('/avatars/skull.png')
})

it('names every historical figure and gives each a pixel sprite', () => {
  const historical = AVATARS.slice(12, 24)
  expect(historical.map(({ label }) => label)).toEqual([
    'Cleopatra', 'Julius Caesar', 'Genghis Khan', 'Joan of Arc', 'Leonardo da Vinci', 'William Shakespeare',
    'Galileo Galilei', 'Isaac Newton', 'Napoleon Bonaparte', 'Ada Lovelace', 'Abraham Lincoln', 'Harriet Tubman',
  ])
  expect(historical.every(({ id, image }) => image === `/avatars/${id}.png`)).toBe(true)
})

it('recognizes uploaded avatar IDs and offers the owner their upload first', () => {
  const custom = `custom-${'ab'.repeat(16)}-0000beef` as const
  expect(isCustomAvatarId(custom)).toBe(true)
  expect(isAvatarId(custom)).toBe(true)
  for (const bad of ['custom', 'custom-xyz', `custom-${'AB'.repeat(16)}-0000beef`, `custom-${'ab'.repeat(16)}-beef`]) {
    expect(isCustomAvatarId(bad)).toBe(false)
    expect(isAvatarId(bad)).toBe(false)
  }
  const avatar = getAvatar(custom)
  expect(avatar).toMatchObject({ id: custom, label: CUSTOM_AVATAR_LABEL, custom: true })
  expect(avatar.image).toMatch(new RegExp(`/avatars/${custom}$`))
  expect(selectableAvatars(custom).map(({ id }) => id)).toEqual([custom, ...AVATAR_IDS])
})

describe('normalizeName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeName('  Wren   Ash \n')).toBe('Wren Ash')
  })
})

describe('isValidPin', () => {
  it('accepts exactly four digits', () => {
    expect(isValidPin('0042')).toBe(true)
    expect(isValidPin('123')).toBe(false)
    expect(isValidPin('12345')).toBe(false)
    expect(isValidPin('12a4')).toBe(false)
  })
})

describe('validateAuthInput', () => {
  it('rejects blank and over-long names', () => {
    expect(validateAuthInput({ mode: 'login', name: '   ', pin: '1234', avatar: null }).name).toBeDefined()
    expect(validateAuthInput({ mode: 'login', name: 'x'.repeat(NAME_MAX_LENGTH + 1), pin: '1234', avatar: null }).name).toBeDefined()
  })

  it('requires a 4-digit pin in both modes', () => {
    expect(validateAuthInput({ mode: 'login', name: 'Wren', pin: '12', avatar: null }).pin).toBeDefined()
    expect(validateAuthInput({ mode: 'register', name: 'Wren', pin: '', avatar: 'moss' }).pin).toBeDefined()
  })

  it('requires an avatar only when registering', () => {
    expect(validateAuthInput({ mode: 'register', name: 'Wren', pin: '1234', avatar: null }).avatar).toBeDefined()
    expect(validateAuthInput({ mode: 'login', name: 'Wren', pin: '1234', avatar: null })).toEqual({})
    expect(validateAuthInput({ mode: 'register', name: 'Wren', pin: '1234', avatar: 'moss' })).toEqual({})
    expect(validateAuthInput({ mode: 'register', name: 'Wren', pin: '1234', avatar: 'cowboy-hat' })).toEqual({})
    expect(validateAuthInput({ mode: 'register', name: 'Wren', pin: '1234', avatar: 'harriet-tubman' })).toEqual({})
  })

  it('requires a cropped image before registering with an upload', () => {
    const customImage = { contentType: 'image/png' as const, data: 'data:image/png;base64,AA==', previewUrl: 'data:image/png;base64,AA==' }
    expect(validateAuthInput({ mode: 'register', name: 'Wren', pin: '1234', avatar: 'custom' }).avatar).toBe('Upload and crop an image, or choose an avatar.')
    expect(validateAuthInput({ mode: 'register', name: 'Wren', pin: '1234', avatar: 'custom', customImage })).toEqual({})
  })
})
