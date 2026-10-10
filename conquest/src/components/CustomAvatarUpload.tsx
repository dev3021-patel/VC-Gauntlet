import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import {
  AVATAR_PIXEL_SIZE, AVATAR_UPLOAD_TYPES, avatarFileError, drawPixelatedCrop, loadAvatarImage, renderAvatarCrop, squareCrop,
  type CropSettings, type LoadedImage,
} from '../avatarImage'
import type { AvatarUpload } from '../session/types'

const CENTERED: CropSettings = { zoom: 1, x: 0.5, y: 0.5 }

/**
 * Pick a PNG/JPEG/WebP file, crop it to a square, and hand the encoded result to
 * `onReady`. A rejected file or failed save leaves any previously saved image alone.
 * `onReady` resolves with an error message to show, or null on success.
 */
export function CustomAvatarUpload({ onReady, disabled = false }: {
  onReady: (upload: AvatarUpload) => Promise<string | null>
  disabled?: boolean
}) {
  const baseId = useId()
  const errorId = `${baseId}-error`
  const zoomRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const [image, setImage] = useState<LoadedImage | null>(null)
  const [crop, setCrop] = useState<CropSettings>(CENTERED)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const imageRef = useRef(image)
  imageRef.current = image
  const refocusRef = useRef(false)

  useEffect(() => () => imageRef.current?.release(), [])
  useEffect(() => {
    if (image) zoomRef.current?.focus()
    else if (refocusRef.current) fileRef.current?.focus()
    refocusRef.current = false
  }, [image])

  const rect = image ? squareCrop(image.width, image.height, crop) : null
  useEffect(() => {
    const canvas = previewRef.current
    const context = canvas?.getContext('2d')
    if (!image || !rect || !context) return
    drawPixelatedCrop(image, rect, context, AVATAR_PIXEL_SIZE)
  }, [image, rect])

  const discard = () => {
    image?.release()
    refocusRef.current = true
    setImage(null)
    setCrop(CENTERED)
  }

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const problem = avatarFileError(file)
    if (problem) {
      setError(problem)
      return
    }
    try {
      const loaded = await loadAvatarImage(file)
      image?.release()
      setImage(loaded)
      setCrop(CENTERED)
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'That image could not be read. Try another file.')
    }
  }

  const confirm = async () => {
    if (!image || saving) return
    setSaving(true)
    setError(null)
    let message: string | null
    try {
      message = await onReady(await renderAvatarCrop(image, squareCrop(image.width, image.height, crop)))
    } catch (saveError) {
      message = saveError instanceof Error ? saveError.message : 'That image could not be saved. Try again.'
    }
    setSaving(false)
    if (message) {
      setError(message)
      return
    }
    discard()
  }

  const slider = (key: keyof CropSettings, label: string, min: number, max: number, step: number) => (
    <label className="avatar-crop-slider">
      <span>{label}</span>
      <input
        ref={key === 'zoom' ? zoomRef : undefined}
        type="range"
        min={min}
        max={max}
        step={step}
        value={crop[key]}
        disabled={saving}
        onChange={(event) => setCrop({ ...crop, [key]: Number(event.target.value) })}
      />
    </label>
  )

  return (
    <div className="avatar-upload">
      {image && rect ? (
        <div className="avatar-crop" role="group" aria-label="Crop your image to a square">
          <canvas
            ref={previewRef}
            className="avatar-crop-preview"
            width={AVATAR_PIXEL_SIZE}
            height={AVATAR_PIXEL_SIZE}
            role="img"
            aria-label="Cropped image preview"
          />
          <div className="avatar-crop-controls">
            {slider('zoom', 'Zoom', 1, 4, 0.05)}
            {slider('x', 'Horizontal', 0, 1, 0.01)}
            {slider('y', 'Vertical', 0, 1, 0.01)}
            <div className="avatar-crop-actions">
              <button type="button" className="secondary-button" disabled={saving} onClick={discard}>Discard</button>
              <button type="button" className="primary-button" disabled={saving} onClick={() => void confirm()}>
                {saving ? 'Saving…' : 'Use image'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <label className={`secondary-button avatar-upload-button${disabled ? ' is-disabled' : ''}`}>
          Upload your own image
          <input
            ref={fileRef}
            type="file"
            className="visually-hidden"
            accept={AVATAR_UPLOAD_TYPES.join(',')}
            disabled={disabled}
            aria-describedby={error ? errorId : `${baseId}-hint`}
            onChange={(event) => void choose(event)}
          />
        </label>
      )}
      <p id={`${baseId}-hint`} className="avatar-upload-hint">PNG, JPEG, or WebP up to 2 MB, cropped to a square and drawn as pixel art. Only you can pick it.</p>
      {error && <p id={errorId} className="field-error" role="alert">{error}</p>}
    </div>
  )
}
