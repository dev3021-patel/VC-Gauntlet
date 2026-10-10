# Gameplay rendering and movement recovery (Issue #39)

Keep `MapCanvas`'s draw scheduler stable: read changing shot data from refs,
and create terrain and the ResizeObserver only for the mounted canvas lifecycle.
Depending on a fresh array recreated each render used to rebuild terrain and
cancel queued frames on every world update.

Movement owns an identity-scoped pending request. A matching command ID from the
ordered stream releases it; HTTP completion can affect state only while it still
owns the pending slot. Death, respawn, authentication changes, world changes,
disconnect, and unmount cancel that ownership. Lost responses trigger snapshot
recovery after five seconds; no ambiguous movement is replayed automatically.
Snapshot bootstrap also has a five-second bound and ignores superseded results.
The existing held-key scheduler skips busy ticks instead of accumulating moves.

Regression coverage lives in `MapCanvas.test.tsx`, `useWorldSync.test.tsx`, and
`worldSync.test.ts`. Browser frame timing still needs real-device verification;
automated mocks do not establish zero user latency.

## Static map repaint and lazy mob occupancy (Issue #111)

`requestDraw` repaints the static map (`drawMap`: backdrop, terrain, shadow,
grid) only when the terrain canvas identity, camera center/zoom, viewport size,
or `mapPixelRatio()` differs from the last successful paint
(`paintedMapRef`). Entity-only frames (remote steps, projectiles, effects) reuse
the canvas; following the local player still repaints each frame because the
camera moves. Camera and viewport refs are always replaced, never mutated, which
keeps that snapshot valid. A `(resolution: Ndppx)` media query triggers a draw
when density changes without a resize. `drawMap` returns `false` when it paints
nothing, so a missing context or empty viewport never records a paint. Tests mock
`drawMap` (returning `true`) to count paints: 1 per frame before, 0 under a fixed
camera after.

`normalize_mobs` reads `player_positions` only on the first stranded mob, so
healthy, empty, and kind/health-only ticks issue no occupancy query.
