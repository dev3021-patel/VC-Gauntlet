// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthModal } from './AuthModal'

vi.mock('../avatarImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../avatarImage')>()),
  loadAvatarImage: vi.fn(async () => ({ source: {} as CanvasImageSource, width: 300, height: 500, url: 'blob:upload', release: vi.fn() })),
  renderAvatarCrop: vi.fn(async () => ({ contentType: 'image/webp', data: 'UklGRg==', previewUrl: 'data:image/webp;base64,UklGRg==' })),
}))

afterEach(cleanup)

const TAKEN = 'Another player is using that avatar right now. Choose a different one.'

function availability(inUse: { avatar: string; playerId: string }[]) {
  return vi.fn(async () => new Response(JSON.stringify({ worldId: 'world-01', inUse }), { status: 200 })) as unknown as typeof fetch
}

function fillCredentials() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Marlowe' } })
  fireEvent.change(screen.getByRole('textbox', { name: '4-digit PIN' }), { target: { value: '1234' } })
}

const SEMANTIC_FIELD_NAMES = ['name', 'username', 'pin', 'password', 'passcode']

it('keeps browser autofill and password managers away from the login inputs', () => {
  render(<AuthModal onSubmit={vi.fn(async () => ({}))} />)
  const form = screen.getByRole('dialog').querySelector('form') as HTMLFormElement
  expect(form.getAttribute('autocomplete')).toBe('off')

  const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
  const pin = screen.getByRole('textbox', { name: '4-digit PIN' }) as HTMLInputElement
  for (const input of [name, pin]) {
    // Chromium's field heuristics ignore autocomplete="off" and key off the
    // field name, so the names must not read as name/credential fields.
    expect(SEMANTIC_FIELD_NAMES).not.toContain(input.name.toLowerCase())
    expect(input.id.toLowerCase()).not.toMatch(/name|pin|pass/)
    expect(input.type).toBe('text')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('data-lpignore')).toBe('true')
    expect(input.getAttribute('data-1p-ignore')).toBe('true')
    expect(input.getAttribute('data-bwignore')).toBe('true')
    expect(input.getAttribute('data-form-type')).toBe('other')
  }
  expect(name.getAttribute('spellcheck')).toBe('false')
  expect(name.getAttribute('autocapitalize')).toBe('off')
})

it('still submits the typed name and PIN under the original payload keys', async () => {
  const onSubmit = vi.fn(async () => ({}))
  render(<AuthModal onSubmit={onSubmit} />)
  fireEvent.click(screen.getByRole('tab', { name: 'Returning player' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Marlowe' } })
  fireEvent.change(screen.getByRole('textbox', { name: '4-digit PIN' }), { target: { value: '1234' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  expect(onSubmit).toHaveBeenCalledWith({ mode: 'login', name: 'Marlowe', pin: '1234', avatar: null })
})

it('scrolls the registration grid and disables avatars that connected players hold', async () => {
  render(<AuthModal onSubmit={vi.fn(async () => ({}))} fetchImpl={availability([{ avatar: 'cleopatra', playerId: 'p2' }])} />)
  expect(screen.getByRole('dialog').querySelector('.avatar-grid-scroll .avatar-grid')).toBeTruthy()
  expect(screen.getAllByRole('radio')).toHaveLength(32)
  const cleopatra = await screen.findByRole('radio', { name: 'Cleopatra In use' }) as HTMLInputElement
  expect(cleopatra.disabled).toBe(true)
  expect((screen.getByRole('radio', { name: 'Harriet Tubman' }) as HTMLInputElement).disabled).toBe(false)
})

it('keeps the form when the server reports the avatar was just taken, so the player can pick again', async () => {
  const onSubmit = vi.fn()
    .mockResolvedValueOnce({ avatar: TAKEN })
    .mockResolvedValueOnce({})
  render(<AuthModal onSubmit={onSubmit} fetchImpl={availability([])} />)
  fillCredentials()
  fireEvent.click(screen.getByRole('radio', { name: 'Ada Lovelace' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create and enter' }))
  expect((await screen.findByRole('alert')).textContent).toBe(TAKEN)
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Marlowe')
  expect((screen.getByRole('textbox', { name: '4-digit PIN' }) as HTMLInputElement).value).toBe('1234')
  fireEvent.click(screen.getByRole('radio', { name: 'Isaac Newton' }))
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Create and enter' }))
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  expect(onSubmit).toHaveBeenLastCalledWith({ mode: 'register', name: 'Marlowe', pin: '1234', avatar: 'isaac-newton' })
})

it('rejects unsupported or oversized files with an accessible error and registers with a cropped upload', async () => {
  const onSubmit = vi.fn(async () => ({}))
  render(<AuthModal onSubmit={onSubmit} fetchImpl={availability([])} />)
  fillCredentials()
  const file = () => screen.getByLabelText('Upload your own image')
  fireEvent.change(file(), { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } })
  expect((await screen.findByRole('alert')).textContent).toBe('Choose a PNG, JPEG, or WebP image.')
  expect(file().getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  const large = new File(['x'], 'big.png', { type: 'image/png' })
  Object.defineProperty(large, 'size', { value: 2 * 1024 * 1024 + 1 })
  fireEvent.change(file(), { target: { files: [large] } })
  expect((await screen.findByRole('alert')).textContent).toBe('That image is larger than 2 MB. Choose a smaller file.')
  expect(screen.queryByRole('radio', { name: 'Uploaded image' })).toBeNull()

  fireEvent.change(file(), { target: { files: [new File(['x'], 'me.jpg', { type: 'image/jpeg' })] } })
  await screen.findByRole('group', { name: 'Crop your image to a square' })
  fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use image' }))
  const uploaded = await screen.findByRole('radio', { name: 'Uploaded image' }) as HTMLInputElement
  expect(uploaded.checked).toBe(true)
  await waitFor(() => expect(document.activeElement).toBe(file()))
  fireEvent.click(screen.getByRole('button', { name: 'Create and enter' }))
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  expect(onSubmit).toHaveBeenCalledWith({
    mode: 'register', name: 'Marlowe', pin: '1234', avatar: 'custom',
    customImage: { contentType: 'image/webp', data: 'UklGRg==', previewUrl: 'data:image/webp;base64,UklGRg==' },
  })
})
