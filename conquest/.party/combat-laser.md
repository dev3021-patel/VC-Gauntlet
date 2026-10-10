> Hackathon starter: use the team-local database and `scripts/dev.sh` described
> in the root README. Historical upstream deployment notes below do not apply.

# Laser (Space / FIRE, Issue #96)

The only shot is an instant laser on the core 2D map (see `core-gameplay.md`).
It uses the `player.shoot` command and the `player.shot` event. No new event
types, weapons, resources, or sounds (the reset removed all game audio).
Decided by the users on 2026-10-02: full-map range, stop at the first unit,
no sound, 1 s cooldown.

## Server contract

- `LASER_RANGE = MOVEMENT_WORLD_SIZE` (`backend/app/player_positions.py`).
  `arrow_path` walks the lane until non-traversable terrain; off-map cells read
  as water, so the map edge ends it too.
- `_shoot` hits only the first body the beam touches (see "Avatar-sized enemy hitboxes" below): the first player (ordered
  lookup, `FOR UPDATE`) or mob (`mob_on_path`), whichever touches first. `path` is
  truncated on the cell holding the contact. Players die in one hit; mobs have 3 health
  and give no rewards.
- `shot_facing` accepts an optional, validated `facing` and falls back to the
  stored facing. `app/realtime.py` `_miss` uses the same helper and range; any
  lane touching a cached player or mob body takes the database resolver.
- Cooldown: `PostgresWorldStore._shot_cadence` (`app/world_transport.py`)
  wraps both `submit` (HTTP) and `submit_live` (socket). It keeps a per-process
  monotonic time per (world, player) and rejects with `shot_cooldown` (429,
  `retryAfterMs`) inside `SHOT_COOLDOWN_SECONDS` (1.0) minus
  `SHOT_COOLDOWN_TOLERANCE_SECONDS` (0.1, for network jitter). A shot rejected
  for any reason gives its slot back. This is authoritative because one owner
  process serves every world in production; a shared Preview backend has its
  own clock. `tests/conftest.py` disables the cooldown unless a test is marked
  `shot_cadence`.
- `src/laser.ts` mirrors the range, the lane walk, body hitboxes, and `LASER_COOLDOWN_MS`.

## Client contract

- `useWorldSync.fire(facing?)` allows one pending shot. It waits for moves
  pending at press time (`settled` on each pending move), then sends with the
  newest confirmed `expectedRevision` (live socket, HTTP fallback) and starts a
  `LASER_COOLDOWN_MS` recharge from the send. Presses while pending or
  recharging are ignored. A `shot_cooldown` rejection is silent. The hook
  exposes `laserRecharging`.
- MapCanvas keeps the newest movement heading as `aim` (set by `steer`, even
  when the step is blocked). Space and touch FIRE both call
  `sync.fire(laserAim(...))`. Aim resets on death or player change.
- Rendering: `.laser-aim` cells form the local-only guide from the predicted
  cell, ending where the first visible player or mob body meets it; `.laser-aim--recharging`
  dims it and touch FIRE gets `virtual-action-fire--recharging` (still
  pressable). `.laser-beam` cells, `.laser-stop` (only for an on-map terrain
  stop), and `.laser-impact` (the hit player or mob) flash for
  `LASER_FLASH_MS`, then `useWorldSync` clears `shot`. `.laser--reduced` is
  the static reduced-motion flash. Cells are sized
  `MOVEMENT_BLOCK_SIZE * camera.zoom` in `requestDraw`.

## Avatar-sized enemy hitboxes (Issue #110)

`backend/app/hitboxes.py` (mirrored in `src/laser.ts`) is the single shot and
body geometry. Enemy bodies are `MOB_BODY_SIZE` = 2.5 cells across, centred on
the mob's cell: melee (`basic`) mobs are square and ranged mobs round. Players
keep a round one-cell body. Health bars, glow, and animations are not bodies.

- Laser: `laser_strike` sweeps the beam from the shooter's leading edge to the
  far edge of the last terrain lane cell, padded by `LASER_HALF_WIDTH` (0.1, the
  drawn beam). The earliest body contact wins, so an enemy one row off the lane
  is hit and two rows off is missed. The path keeps lane cells up to the one
  holding the body's own edge. For players that is their cell; for an on-lane
  mob it is the cell before its centre. `mob_on_path(connection, world, origin,
  facing, path)` locks every world mob (at most four) and returns the one struck
  first. `_shoot` then compares it with the first lane player through the same
  function. `WorldRuntime._miss` treats cached mobs (no kind) as the larger
  square body and defers any possible contact to the resolver.
- Rockets: `advance_shot` uses `body_contact` with `PROJECTILE_RADIUS` as the
  pad, so rocket friendly fire hits mob bodies at their edge. Players keep the
  former 0.65 combined radius.
- Rendering: `requestDraw` sets `--mob-body-size` to
  `MOVEMENT_BLOCK_SIZE * zoom * MOB_BODY_SIZE` on each `.mob-marker`, so the
  drawn body equals the hitbox at every zoom and zoom never affects hits. The
  health bar is absolutely positioned above, so the marker (and its centring
  transform) is exactly the body. Mob `.laser-impact` rings are body-sized
  (`LaserCell.size`). The aim guide uses `laserStrike` with the visible players
  and mobs.
