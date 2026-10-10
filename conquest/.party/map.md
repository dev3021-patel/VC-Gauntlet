> Hackathon starter: use the team-local database and `scripts/dev.sh` described
> in the root README. Historical upstream deployment notes below do not apply.

# Expanded map (Issue #24)

`backend/app/map-layout.json` is the shared, block-aligned terrain source.
TypeScript imports it; Python loads it alongside the backend application, so the
Docker image includes the same map. Walkable types are land, bridge, and courtyard.
Trees, barricades, walls, and water stop both movement and arrows. Each movement
block remains 8×8 terrain pixels; player avatars remain 34 CSS pixels.

Tree and barricade art (`treeOverlay` / `barricadeOverlay` in `src/mapRenderer.ts`)
is painted inside that same 8×8 footprint. Trees keep grass in the cell corners,
with an irregular crown, a trunk, and a ground shadow. Barricades are spiked
crossed logs; a horizontal neighbor shares the binding-log pixels so a pair
joins, and the outer ends keep posts. Bridge plank colors stay on bridges.

Baseline: 421 traversable blocks out of 32×32, 29,312 water pixels out of 65,536
(44.73%). Expanded map: 1,270 traversable blocks out of 40×40 (3.017×), 252 water
blocks out of 1,600 (15.75%). Three two-block-wide bridges crossed the river (four rows each since Issue #110, see below); the
northeastern fortress has west and south entrances. All traversable blocks form
one orthogonally connected component.

Courtyard openings are plain walkable gaps. Interactive doors (migration 0019,
`world_doors`) were retired in Issue #95; the table remains but is not read.

Migration 0007 expands bounds without deleting positions; coordinate contract 3
retains the meaning of each coordinate. On snapshots and before commands,
invalid positions are reconciled under the world-stream row lock. Valid positions
are reserved and preserved; invalid players receive unique safe blocks and
ordered `player.respawned` events via transactional notifications. No safe location
rolls reconciliation back and returns `no_spawn_available`; valid actors can still
act to free capacity. Accounts and death history survive.
Deploy the migration, backend, and frontend together. Old clients use old terrain
and should reload. The shared-production Preview cannot serve this change until
the migration is deployed; never apply it just to make Preview pass. Use the
opt-in isolated mode in `preview.md` to review pending migrations beforehand.

Verification: `npm run build`, `npm test`, and the backend tests in
`test_player_positions.py`, `test_expanded_map.py`, and `test_migrations.py`.
Database integration tests require a disposable `TEST_DATABASE_URL`; never point
these tests at the shared production schema.

Issue #40 expands the shared layout to 80×80. The prior 40×40 terrain is offset
to the lower-right quadrant by +40,+40, with only its former north and west
borders opened for internal seams. Migration 0015 applies the same translation
atomically to player positions, gold drops, and active treasure chests, retains expiry/progression data,
widens both tables to coordinates 0–79, and advances coordinate contract 4.
The upper river connects to the prior channel, bends east, and exits at x=79;
the two left quadrants contain accessible walled courtyards. Transport schema 2
fails closed between cached 40×40 clients and the expanded backend. Retained
replay envelopes keep their original schema version and coordinates, allowing
the client's schema-mismatch handling to request a fresh translated snapshot.

The map JSON is also a frontend build input. CI classification and frontend
push path filters explicitly include `backend/app/map-layout.json`, so a map-only
change rebuilds both services. The world API rejects incompatible schemas before
attempting any relocation write.

## Fit world camera (Issue #59)

"Fit world" in `MapCanvas.tsx` is a sticky toggle (`fitWorldActive`, mirrored in a
ref for effects). While active, the follow-player effect skips recentring and the
resize observer re-fits instead of clamping. `commitCamera` sets the camera without
touching the mode; `applyCamera` wraps it and exits fit-world, so every manual pan,
zoom, and "My player" press leaves the mode and the button's `aria-pressed` always
matches the screen. Camera tests use `.player-marker`'s transform at an 800×600
viewport; place the test player mid-world first, because `constrainCamera` clamps a
400% camera near the world edge and the marker will not sit at the viewport centre.

## Cube world (Issue #78), retired in Issue #95

The six-face cube atlas was removed. `map-layout.json` is the single 80×80
grid again (top-level `rows`, no `faces`), and `scripts/generate-cube-faces.py`,
`src/cube*.ts`, and `backend/app/cube.py` are gone. `terrain-contract.json` is
the 80×80 block hash again. `0026_cube_world.sql` (the widened x check up to
484) stays applied; it is harmless because every stored position
outside 0–79 is relocated by `relocate_invalid_positions` on the next snapshot
or command. Players never move between faces. See `core-gameplay.md`.

## Four-row bridges (Issue #110)

Every crossing of the three-column river (x 58–60) is four bridge rows wide:
rows 31–34, 48–51, 59–62, and 70–73, centred on the earlier one- and two-row
crossings (32, 49–50, 60–61, 71–72). Each row is open land at x 57 and x 61, so
the full width is reachable from both banks. Only water became bridge, so no
stored position becomes invalid and `coordinateVersion` stays 5.
`terrain-contract.json` (hash and `traversableBlocks` 5,704) changes with any
map edit; regenerate it from the backend's `terrain_at` loop in
`test_terrain_contract_matches_known_map_regions`. The renderer
(`mapRenderer.ts`) draws rails only on a bridge cell's north/south edge without
a bridge neighbour, so wider bridges keep rails on their outer edges only.
`test_expanded_map.py` checks width, banks, and lane connectivity for every
bridge.

## Balanced trees and barricades (Issue #119)

`scripts/balance-map-obstacles.py` owns tree (`T`) and barricade (`B`) placement.
It clears every obstacle, re-adds seven landmark obstacles that tests rely on, then
places at most one tree, single barricade, or horizontal barricade pair per 8×8 tile
(seed 119, deterministic). Placement uses only open land with no water, wall,
courtyard, or bridge within 2 blocks, no bridge or courtyard opening within 4, and
no other obstacle within 3. Rows 1–5 for x 1–56 (the lane north of the northwest
fortress) stay clear because mob, projectile, and laser tests use them as an open
arena. The script refuses to write a layout that breaks walkable connectivity.
Result on 80×80: quadrants hold 23/30/23/21 obstacles (UL/UR/LL/LR), up from
4/4/4 and down from 39. `test_trees_and_barricades_are_balanced_across_quadrants_and_keep_routes_open`
guards the bounds and route clearances.

Re-run the script after any terrain change rather than scaling the old counts.
Then regenerate `terrain-contract.json`. Land that becomes an obstacle needs no
migration or `coordinateVersion` bump: `relocate_invalid_positions` and mob
normalization move stranded players and mobs on the next snapshot or command.
Use isolated Preview mode before deployment, because shared mode would relocate
production players.
After merging the Issue #118 entrances, the script was re-run on that terrain:
quadrant counts were unchanged, one barricade moved a square west, and
`traversableBlocks` is 5,671.

## Four-square entrances (Issue #118)

Every courtyard entrance is at least four squares wide: NW fortress west
(x 8, y 13–16) and south (y 23, x 16–19); SW fortress north (y 50, x 16–19) and
east (x 27, y 58–61); east fortress west (x 65, y 47–50) and south
(y 54, x 69–72). Each widening kept the original gap, and the barricade pair
at (69–70, 56) in front of the east south entrance became land. Only wall and
barricade cells became walkable (5,704 to 5,719 traversable), so
`coordinateVersion` stays 5. `courtyard_entrances()` in `test_expanded_map.py`
finds every courtyard cell bordering outside walkable ground. The rule test
requires each run to be at least 4 wide, with walkable cells 2 squares out and
1 square into the courtyard. New structures must pass it. If the map is translated, update the exact-location test as well.

## October baseline restore (Issue #151)

The shared layout is 80×80 again, coordinate contract 5. Migration 0038 relocates
living rows with a coordinate outside 0–79 into the northern lane and normalizes
mob kind, health, and count. It does not drop the expansion, space, or ghost
tables, and it does not insert a position for a defeated player. Cells inside
the map that are no longer walkable still move on the next snapshot or mob tick.

## Map grid (Issue #115)

The grid overlay in `drawMap` (`src/mapRenderer.ts`) only ever draws atomic
8×8 movement cells (`MOVEMENT_BLOCK_SIZE`). Below `MIN_GRID_ZOOM` (1.5, i.e.
150%) `getGridStep` returns `null` and no interior lines are drawn; terrain and
the outline still paint. Do not reintroduce coarser 16/32 substitute grids:
the owner found grids that change spacing with zoom confusing.
