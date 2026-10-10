> Hackathon starter: use the team-local database and `scripts/dev.sh` described
> in the root README. Historical upstream deployment notes below do not apply.

# Player avatars

The canonical frontend IDs are `AVATAR_IDS` in `src/session/types.ts`; the backend allowlist is `AVATARS` in `backend/app/players.py`. Keep both lists in the same order and cover equality in frontend and backend tests. The first six IDs are the original CSS-rendered circular glyphs. Pixel-art PNGs live in `public/avatars/` and are referenced by `src/session/avatars.ts`.

In-game changes use the authenticated `player.avatar` world command. `backend/app/player_positions.py` validates the ID, updates `players.avatar`, and returns `player.avatar_changed` inside the authoritative world transaction. Avatar saves require authentication, ownership, and world availability, but no active life or position revision. Positioned responses retain the full public position for rolling-deploy compatibility; defeated responses contain only `playerId` and `avatar`. The position revision and gameplay coordinates do not change. `useWorldSync` applies avatar updates cosmetically to existing markers only, tracks their revisions independently of position confirmations, and preserves death state and the explicit rejoin revision. It accepts both HTTP outcomes and ordered streamed events, while `useAuth.updatePlayer` refreshes the browser-stored account after the local save succeeds.

`AvatarChangeModal` owns pending selection, failure recovery, Save/Cancel, Escape/backdrop dismissal, initial focus, and focus containment. `MapCanvas` blocks keyboard movement, firing, shortcuts, canvas gestures, and navigation controls while it is open, then restores focus to **Change avatar**.

Validation: `npm run build`, `npm test`, and backend `python -m pytest -q`. PostgreSQL persistence/replay coverage in `test_player_positions.py` needs a disposable `TEST_DATABASE_URL`; never run it against the shared production schema.

## Facing indicator on the avatar edge

The player-facing badge (`.facing-indicator` in `src/styles.css`) is an absolutely
positioned 18×18px circle with the dark backing at 60% opacity, centered on the
north/east/south/west edge midpoint of the 34×34px `.avatar-md` so the sprite stays
visible (Issue #60; chosen from pixel-accurate in-game mockups after a centered 14px
badge was rejected as still covering the sprite). The arrow is drawn with a
`clip-path` on `::before` and rotated per direction, not a font glyph: the Unicode
horizontal arrows render thinner than the vertical ones and are not optically centered.
The badge uses `z-index: -1`:
inside the `.player-marker` stacking context a negative z-index paints under the in-flow
avatar, so the sprite is always the top layer and only the badge's outer half shows
([Issue #74](https://app.party.build/issues/74)). Do not give the badge a non-negative
z-index or position the avatar; either change puts the badge back over the sprite.
`MapCanvas` renders an empty span with `facing-indicator--<direction>` and
`data-facing`; there is no text content. It sits after the avatar
inside `.player-marker-visual` and never contributes marker layout size.
`src/facingIndicatorStyles.test.ts` guards size, opacity, the drawn arrow, and cardinal
placement; the `player facing indicator` block in `MapCanvas.test.tsx` guards marker
structure, direction classes, and avatar changes.

**Change avatar** must stay a direct child of the `.game-action-controls` stack in `MapCanvas` with no standalone `position`/`bottom` rules of its own. An independently anchored avatar button previously landed on top of another control in the same corner ([Issue #64](https://app.party.build/issues/64)); `MapCanvas.test.tsx` and `scripts/verify-action-layout.py` both guard the stack.

## All avatars free (Issue #95)

The avatar shop (Issue #70) was removed. `AVATARS` in `backend/app/players.py`
and `AVATAR_IDS` in `src/session/types.ts` list all 32 built-in IDs, every one
selectable at registration and through **Change avatar**. The eight former paid
IDs (`robot`, `dragon`, `crown`, `ghost`, `cat`, `alien`, `wizard`, `skull`)
are ordinary free entries. `player_avatar_unlocks` (migration 0021) is no longer
read, and `player.buy_avatar` no longer exists. Sprites are 16×16 pixel grids
scaled to 256×256 PNGs generated with the standard library only (no Pillow on
Party workers); keep transparent backgrounds.

## Historical figures, uploads, and world uniqueness (Issue #80)

Issue #80 added 12 historical figures (`cleopatra` … `harriet-tubman`) after
the launch 12. Their sprites come from
`scripts/generate-historical-avatars.py` (stdlib only: 16×16 grids written as
mirrored 8-pixel halves plus an `ACCENTS` override for asymmetric details,
scaled to 256×256). Re-run it after editing a grid; never hand-edit the PNGs.

Each account may keep one uploaded image in `player_custom_avatars`
(migration 0025, after heavy grenades (0024) and the spider-web migrations 0022 and 0023). Its avatar ID is `custom-<owner uuid hex>-<8 hex version>`, so
rendering needs only the ID and ownership is the embedded UUID. A replacement
mints a new version; `GET /avatars/<id>` always serves the owner's latest image
(public, 5-minute cache, `nosniff`), so stale IDs never break. Uploads go through
`POST /players/register` (`customAvatar: {contentType, data}` with raw base64, no `data:` prefix) or
`PUT /players/me/custom-avatar`; the backend sniffs magic bytes, accepts only
PNG/JPEG/WebP up to 2 MB, and a rejection leaves the stored row untouched. The
browser (`src/avatarImage.ts`, `CustomAvatarUpload`) square-crops, averages that
crop onto a 16×16 grid, and saves a 256×256 PNG of those blocks. The crop preview
shows the pixel art. An image already saved stays unchanged until the player
uploads a replacement. Only the owner may select a
`custom-*` ID (`avatar_claims.ensure_selectable`); everyone renders it.

Uniqueness covers built-in avatars only and is per world, in
`world_avatar_claims` (PK `(world_id, avatar)`), managed by
`backend/app/avatar_claims.py`. A claim counts only while its holder has a fresh
`player_world_connections` lease (`STALE_CONNECTION_SECONDS`), so release follows
presence and disconnect timeouts. Claims are taken by `player.avatar`, `player.place`
(optional `avatar` payload lets a returning player choose before spawning), and
on WebSocket connect (`player_connected` returns whether the saved avatar was
claimed; if not, the socket sends the private frame
`{"type": "avatarStatus", "available": false}`). Conflicts are `avatar_in_use`
(409, world commands) or `avatar-in-use` (registration, which checks every
world). Pickers poll `GET /v1/worlds/<id>/avatars` every 4 s while open
(`useAvatarAvailability`) and disable taken options with an "In use" label. A
positioned player whose avatar is contested is not blocked server-side; the
client forces the required **Choose another avatar** modal. Placement is
enforced server-side.

Mocked backend tests stub the claim functions through the autouse
`uncontested_avatars` fixture in `backend/tests/conftest.py`; mark a test
`real_avatar_claims` to opt out. Real PostgreSQL coverage lives in
`backend/tests/test_avatar_claims.py` (disposable schemas via `TEST_DATABASE_URL`).
