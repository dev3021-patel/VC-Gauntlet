# How to play panel (Issue #77 / GitHub #142)

`src/howToPlay.ts` stores the first-visit dismissal on the device as
`party-conquest.how-to-play` = `{ version: 4, dismissed: true }`, through the
injected `syncDeps.storage` / `browserStorage()`. Missing, malformed, or
older-version data opens the panel again. Bump `HOW_TO_PLAY_VERSION` to re-show
it to everyone after a major controls change. Issue #95 bumped it to 2 when the
controls were cut down to the core set. Issue #104 bumped it to 3 for the stealth
control, and Issue #110 to 4 when stealth was retired.

Copy (`src/components/HowToPlayPanel.tsx`) lists only retained actions:

- keyboard: WASD or Arrow keys to move, Shift held to sprint (2×), R to taunt, Space to shoot (also while sprinting). Issue #113 removed the
  Space rejoin row; Space still rejoins in game (`MapCanvas`) and the defeat
  dialog's button shows the `Space` hint;
- touch: the pad, FIRE, Rejoin, drag, and pinch, plus a note that Change avatar is in the Player actions button.

`HowToPlayPanel.test.tsx` asserts that no removed-feature words appear
(`steal` also bans retired stealth wording, as do `hidden` and `detected`). Keep it
in step with `core-gameplay.md`.

`MapCanvas` owns the open state (`'first-visit' | 'reopened' | null`):

- It folds the panel into `inputBlocked`, so canvas pointer/wheel input and the
  virtual pad are disabled, and `handleKeyDown` returns early through
  `howToPlayOpenRef`.
- `HowToPlayPanel` owns focus: it focuses Got it (again in a frame, because the
  sign-in form focuses its name field after mount), traps Tab, and handles
  Escape in a window capture listener.
- The panel is portaled to `document.body` with `position: fixed`.
  `.map-viewport` has `isolation: isolate`, and the sign-in `.register-backdrop`
  is a sibling of the map in `App`, so a panel inside the map can never sit
  above the sign-in dialog. On a first visit the panel opens _over_ the sign-in
  dialog. Browser scripts must click **Got it** before filling the form, or the
  `.how-to-play-backdrop` intercepts the click.
- The dock button glows for `HOW_TO_PLAY_HIGHLIGHT_MS` only after a first-visit
  dismissal, and only once a player exists (signed out, the sign-in backdrop
  covers the dock). Reduced motion gets a static ring instead.

Layout: the outer panel has a fixed height (`min(640px, 100%)`). The header,
Objective, and footer never scroll; only `.how-to-play-controls-scroll` does.
Keep new copy short, because at 844×390 the list keeps only about two rows
visible (the verifier requires at least 72 px). The desktop `.navigation-help`
caption sits under the brand panel and covers map navigation only. The full
key list lives in the panel.

Tests: suites that exercise gameplay input must start from a returning device.
`App.test.tsx`, `MapCanvas.test.tsx`, and `deathAttribution.test.tsx` seed
`localStorage` and their `memoryStorage()` helpers with the dismissed value.
`HowToPlayPanel.test.tsx` starts fresh.

Geometry check (normal and clean view at 1280×720, 1024×640, 390×844, 375×667,
and 844×390, plus the open panel):

```bash
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright uvx --with playwright python scripts/verify-how-to-play-layout.py [screenshot-dir]
```

It checks only pairs that involve the button or a dock slot.
