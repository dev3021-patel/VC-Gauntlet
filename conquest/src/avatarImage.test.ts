import { expect, it } from 'vitest'
import { AVATAR_PIXEL_SIZE, AVATAR_UPLOAD_MAX_BYTES, avatarFileError, cropPreviewStyle, squareCrop } from './avatarImage'

it('uses the same 16 by 16 grid as the built-in sprites', () => {
  expect(AVATAR_PIXEL_SIZE).toBe(16)
})

it('accepts PNG, JPEG, and WebP files up to 2 MB', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) expect(avatarFileError({ type, size: AVATAR_UPLOAD_MAX_BYTES })).toBeNull()
  expect(avatarFileError({ type: 'image/gif', size: 10 })).toBe('Choose a PNG, JPEG, or WebP image.')
  expect(avatarFileError({ type: 'image/svg+xml', size: 10 })).toBe('Choose a PNG, JPEG, or WebP image.')
  expect(avatarFileError({ type: 'image/png', size: AVATAR_UPLOAD_MAX_BYTES + 1 })).toBe('That image is larger than 2 MB. Choose a smaller file.')
})

it('crops the largest centered square and slides or zooms within the image bounds', () => {
  expect(squareCrop(400, 300, { zoom: 1, x: 0.5, y: 0.5 })).toEqual({ sx: 50, sy: 0, size: 300 })
  expect(squareCrop(300, 500, { zoom: 1, x: 0.5, y: 1 })).toEqual({ sx: 0, sy: 200, size: 300 })
  expect(squareCrop(400, 400, { zoom: 2, x: 0, y: 1 })).toEqual({ sx: 0, sy: 200, size: 200 })
  expect(squareCrop(400, 300, { zoom: 0.5, x: 2, y: -1 })).toEqual({ sx: 100, sy: 0, size: 300 })
})

it('previews the crop by scaling and positioning the source image', () => {
  expect(cropPreviewStyle(400, 400, { sx: 0, sy: 200, size: 200 })).toEqual({ backgroundSize: '200% 200%', backgroundPosition: '0% 100%' })
  expect(cropPreviewStyle(300, 300, { sx: 0, sy: 0, size: 300 })).toEqual({ backgroundSize: '100% 100%', backgroundPosition: '50% 50%' })
})
