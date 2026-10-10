# Spawn clouds

Live player arrivals show the existing `.spawn-smoke` cloud at the destination.
`useWorldSync` adds a reveal only while the stream is connected, for
`player.placed` events that carry `firstSpawn` (initial spawn or combat-death
rejoin). Snapshot
hydration and reconnect catch-up stay silent. An already-active `player.placed`
omits `firstSpawn` and does not cloud. Reveal ids are `commandId:revision`, so
a repeated delivery of the same event does not add a second cloud. Each reveal
is its own element and expires on the existing 900 ms timer.

# Player marker alignment

`MapCanvas.tsx` projects `movementBlockCenter(x, y)` through `worldToScreen`
for both local and remote players. Keep this anchor on the actual movement
block even when the canvas draws coarser gridlines.

The marker's percentage translation must center only the avatar. Keep name
labels absolutely positioned below it so name wrapping cannot change the
marker's height. The shared `avatar-md` size remains 34 CSS pixels.

The shared `.facing-indicator` is absolutely centered at 50% on both axes
with a two-axis half-size translation. Its fixed dark backing keeps direction
glyphs readable over avatars without contributing to marker dimensions.

## Movement interpolation (Issue #54)

Marker smoothing is presentation-only and lives in `markerMotion.ts` plus the
`MapCanvas` draw loop. `MapCanvas` keeps one `MarkerMotion` per player ID in a
ref, reconciled in an effect whenever `position` or `sync.players` changes; the
draw loop projects `displayedPoint(motion, performance.now())` and re-requests a
frame only while a motion is unsettled. Gameplay, occupancy, facing, labels, and
the `aria-live` location text keep reading authoritative coordinates.

Only a one-orthogonal-cell change animates. First placement, respawn, reconnect,
map relocation, reappearance after removal, diagonal or multi-cell
corrections, and reduced motion snap to the cell center. A newer adjacent target
retargets from the currently displayed point instead of queuing. Local steps use
the held-movement cadence (`MOVE_REPEAT_MS`, 80 ms); remote steps use the
interval since that player's previous step, bounded to that cadence.

The camera follows the interpolated local position through `followPlayerRef`.
Wheel/pointer panning and Fit world release following; an accepted local move or
Return to player re-engages it, matching the previous recenter-on-move behavior.
Component tests drive frames with a stubbed `requestAnimationFrame` and
`performance.now`, and flush passive effects with `act` before advancing.

Browser verification for Issue #54 used the shared-data Preview with a Dev
tools mock player (local-only movement, no production writes). Sampling remote
marker transforms while holding a key at 266% zoom showed the world sliding in
small per-frame steps instead of 21 px cell jumps; with `reduced_motion: reduce`
the marker produced exactly one transform per announced cell.

Cadence history: 80 ms since Issue #86, 100 ms since Issue #75, 200 ms before.
Speed boosts and Nitro (Issue #57) were removed in Issue #95, so there is one
standard speed. Fit-world mode suppresses interpolated camera following until
explicitly exited.

Continuous local motion (Issue #86): `useWorldSync` publishes `predictedPosition`,
the destination of the newest in-flight move, and `MapCanvas` targets the local
marker at `predictedPosition ?? position`, so it glides the moment a move is
submitted instead of after confirmation. Held input pipelines
`MAX_MOVES_IN_FLIGHT` (2) moves, so one round trip never
stalls the 80 ms cadence. `advanceMotion` treats its duration as time per full
cell and scales it by remaining distance, keeping one steady speed across
consecutive cells, reversals, turns, and a rejected prediction gliding back to the
confirmed cell. Gameplay text and collisions still read confirmed positions.
Shots carry the confirmed `expectedRevision`, which lags while moves are in
flight. The backend's `revision_is_current` therefore lets `PROJECTILE_ACTIONS`
(only `player.shoot` since Issue #95) trail by up to `PROJECTILE_REVISION_LAG` (8)
revisions; they still launch from the committed cell. The client waits for moves
pending at press time before sending a shot (see `combat-laser.md`). Every other
command, including moves, still requires the exact revision.

## Grass rustle (Issue #101)

`src/grassRustle.ts` derives a presentation-only grass patch from the same
`MapCanvas` motion reconciliation that drives marker interpolation:
`grassRustleFor(previous, next)` fires only when `advanceMotion` returns a new
animated adjacent step onto `land`. Do not add a separate timer, cadence, or
input hook for it; snaps (spawn, respawn, reconnect, teleport, corrections,
reduced motion) and unchanged cells therefore never rustle.

The patch is two tufts flanking the avatar's lower half at a fixed on-screen
size (`GRASS_PATCH`, mirrored by `.grass-rustle`). A cell-sized patch was tried
and was invisible: at the default ~95% zoom a cell is under 8 px and the 34 px
avatar covers it and its neighbours, and the name label sits directly below.
`grassPatchOnGrass` hides the patch whenever any block under its footprint is
not land of the same `grassColor` shade; blades use `grassColor` and
`GRASS_SPECK_COLOR` from `mapRenderer.ts`. Patches are positioned on mount and
in the draw loop without extending its `animating` frames, expire on a
`GRASS_RUSTLE_MS` (350 ms) timer, and are capped at `MAX_GRASS_RUSTLES`.

Headless Chromium at device scale 3–4 renders this map at roughly one frame per
300 ms, so a 350 ms effect can expire before a screenshot. For captures, place
a Dev tools mock player by pre-seeding `party-conquest.position.<id>` with a
fixed `Date.now`, and stretch the 350 ms timer in an init script.
