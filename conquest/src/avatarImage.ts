import type { AvatarUpload } from './session/types'

export const AVATAR_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const AVATAR_UPLOAD_MAX_BYTES = 2 * 1024 * 1024
/** Uploads are re-encoded to this square size, far below the server's 2 MB limit. */
export const AVATAR_OUTPUT_SIZE = 256
/** Same grid as the built-in pixel sprites, so a photo reads as one of them. */
export const AVATAR_PIXEL_SIZE = 16

/** An actionable message for a file the picker cannot accept, or null when it is usable. */
export function avatarFileError(file: Pick<File, 'type' | 'size'>): string | null {
  if (!(AVATAR_UPLOAD_TYPES as readonly string[]).includes(file.type)) return 'Choose a PNG, JPEG, or WebP image.'
  if (file.size > AVATAR_UPLOAD_MAX_BYTES) return 'That image is larger than 2 MB. Choose a smaller file.'
  return null
}

/** `zoom` ≥ 1 shrinks the square; `x`/`y` in [0, 1] slide it across the spare width/height. */
export type CropSettings = { zoom: number; x: number; y: number }
export type CropRect = { sx: number; sy: number; size: number }

export function squareCrop(width: number, height: number, { zoom, x, y }: CropSettings): CropRect {
  const size = Math.min(width, height) / Math.max(1, zoom)
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  return { sx: (width - size) * clamp(x), sy: (height - size) * clamp(y), size }
}

/** CSS background placement that previews a crop rectangle in a square frame. */
export function cropPreviewStyle(width: number, height: number, crop: CropRect): { backgroundSize: string; backgroundPosition: string } {
  const spareX = width - crop.size
  const spareY = height - crop.size
  return {
    backgroundSize: `${(width / crop.size) * 100}% ${(height / crop.size) * 100}%`,
    backgroundPosition: `${spareX > 0 ? (crop.sx / spareX) * 100 : 50}% ${spareY > 0 ? (crop.sy / spareY) * 100 : 50}%`,
  }
}

export type LoadedImage = { source: CanvasImageSource; width: number; height: number; url: string; release: () => void }

export function loadAvatarImage(file: Blob): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => resolve({
      source: image, width: image.naturalWidth, height: image.naturalHeight, url, release: () => URL.revokeObjectURL(url),
    })
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('That image could not be read. Try another file.'))
    }
    image.src = url
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('That image could not be read. Try another file.'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Average the crop down to the sprite grid, then scale those blocks back up
 * with hard edges. PNG keeps the blocks intact; WebP would blur them.
 */
export function drawPixelatedCrop(image: LoadedImage, crop: CropRect, dest: CanvasRenderingContext2D, destSize: number): boolean {
  const small = document.createElement('canvas')
  small.width = AVATAR_PIXEL_SIZE
  small.height = AVATAR_PIXEL_SIZE
  const reduced = small.getContext('2d')
  if (!reduced) return false
  reduced.imageSmoothingEnabled = true
  reduced.drawImage(image.source, crop.sx, crop.sy, crop.size, crop.size, 0, 0, AVATAR_PIXEL_SIZE, AVATAR_PIXEL_SIZE)
  dest.imageSmoothingEnabled = false
  dest.clearRect(0, 0, destSize, destSize)
  dest.drawImage(small, 0, 0, destSize, destSize)
  return true
}

/** Draws the square crop as pixel art and encodes it as a PNG. */
export async function renderAvatarCrop(image: LoadedImage, crop: CropRect): Promise<AvatarUpload> {
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_OUTPUT_SIZE
  canvas.height = AVATAR_OUTPUT_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot prepare images. Try another browser.')
  if (!drawPixelatedCrop(image, crop, context, AVATAR_OUTPUT_SIZE)) throw new Error('This browser cannot prepare images. Try another browser.')
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob || blob.type !== 'image/png') throw new Error('This browser cannot prepare images. Try another browser.')
  const previewUrl = await blobToDataUrl(blob)
  return { contentType: 'image/png', data: previewUrl.slice(previewUrl.indexOf(',') + 1), previewUrl }
}
