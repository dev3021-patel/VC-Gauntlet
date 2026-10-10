# Virtual touch controls and input mode (Issue #69)

`useInputMode` (`src/useInputMode.ts`) returns `touch` when
`(pointer: coarse), (max-width: 680px)` matches and re-evaluates on media query
`change` events. The query string is exported as `TOUCH_INPUT_QUERY` and must
stay identical to the stylesheet's mobile breakpoint so the pad and the HUD
layout flip together. Party app webviews and phone browsers report a coarse
pointer; no app-specific user agent or query parameter is inspected. The hook
tolerates `matchMedia` stubs without `addEventListener` (several tests stub it
that way) and reports `pointer` when `matchMedia` is missing.

`VirtualControls` (`src/components/VirtualControls.tsx`) renders inside
`MapCanvas` only while the input mode is `touch`, the player is placed, alive,
and signed in. It stays mounted in clean view (dimmed like the control dock)
because gameplay controls are never hidden there. `MapCanvas` adds
`map-viewport--touch` to the section in touch mode.

- Movement buttons use Pointer Events with per-button pointer capture. Press
  calls `pressMovement('touch:<direction>', direction)` and release, cancel, or
  lost capture calls `releaseMovement`; these are the same `useCallback`
  helpers the keyboard handlers use, so the 80 ms cadence, latest-direction
  priority, and blocked-move rules are shared. Touch keys are prefixed
  `touch:` so they never collide with keyboard keys.
- The only action button is **FIRE** (`aria-label="Fire"`), the touch twin of
  Space. Since Issue #95 it sits alone in the centre cell of the 3×3
  `.virtual-actions` grid.
- `touch-action: none`, `preventDefault` on `pointerdown`, and a suppressed
  context menu keep presses from panning, zooming, focusing, or long-press
  selecting. Two fingers work because each button captures its own pointer.
- Accessible names: `Move up/down/left/right` and `Fire`.

Layout (`src/styles.css`, "Virtual control pad"): the pad hugs the bottom edge
so the camera-centred local player stays visible. In touch mode the control
dock moves to the top centre (below the brand panel and world badge), and the
help caption and the Player actions strip (Change avatar) sit directly above the
pad, offset by the `--virtual-pad-height` custom property. Cells are 56 px,
52 px under 400 px wide, and 48 px under 520 px tall. On landscape phones the
strip moves between the two clusters at the bottom. The world status pill hides
its text on phones, so browser scripts must wait for `Synced` with
`state="attached"`, not visible. The dev-only Dev tools panel moves below the
dock on touch layouts (`src/components/devTools.css`), because at the bottom
right it covered FIRE.

Verify geometry with
`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright uvx --with playwright python scripts/verify-touch-controls-layout.py [screenshot-dir]`.
It also asserts that nothing touch-positioned covers the screen centre. Update
its mirrored markup whenever pad buttons or nearby regions change.

Preview feedback on 2026-09-18 showed the first layout (pad above a three-row
dock) covering the player and nearby avatars on a 440 px phone; that is why
the dock lives at the top in touch mode. The dock's first slot is the How to
play button. See `how-to-play.md`.
