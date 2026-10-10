> Hackathon starter: use the team-local database and `scripts/dev.sh` described
> in the root README. Historical upstream deployment notes below do not apply.

# Core 2D gameplay reset (Issue #95)

Party Conquest was deliberately reset to its core loop. Do not reintroduce a
removed system without a new Issue that asks for it.

Retained:

- the flat 80×80 map (`backend/app/map-layout.json` has top-level `rows`), with
  follow camera, pan, zoom, My player, and Fit world;
- 32 free avatars, sign-in, uploads, and **Change avatar**;
- smooth standard-speed movement (`MOVE_REPEAT_MS` 80 ms; keyboard and touch
  share one scheduler), plus a keyboard-only Shift sprint (`SPRINT_REPEAT_MS`
  40 ms, Issue #106; see `how-to-play.md` for controls);
- the R taunt (Issue #106): a transient, cosmetic multiplayer buzz (see
  `realtime.md`);
- an instant full-map laser (Space / touch FIRE) that stops at terrain, the map edge, or the first unit, with a 1 s cooldown (Issue #96, see `combat-laser.md`);
- one-hit PvP, and melee `basic` and `ranged` mobs with 3 health, at most 4 of them, and
  no rewards;
- the defeated screen with **Rejoin world** (or Space): the same account and
  avatar respawn straight away, and the player cannot move or fire until then;
- a minimal HUD and the How to play panel;

Removed: cube faces, gold, XP, cosmetic tiers, shops, shields, chests, treasure
hunts, doors, special and spread shots, grenades, webs, Speed and Nitro,
stealing, stealth (Issue #110, see `stealth.md`), streaks, self-destruct, kill announcements and all game audio
(including the mute controls), leaderboards, stats, the exploration journal, and
movable overlays.

## Data compatibility

- The reset itself added or edited no migration (retired stealth later added 0032, still applied). Tables owned by retired features
  (`gold_drops`, `player_progression`, `player_special_charges`,
  `combat_records`, `player_powerups`, `player_speed_effects`,
  `world_powerup_cycles`, `player_nitro`, `world_doors`,
  `player_treasure_hunts`, `player_avatar_unlocks`, `world_webs`, and
  `heavy_grenade_drops`) stay untouched and are no longer read or written. Rolling back keeps their data.
- Positions on retired cube faces (x ≥ 80) or other non-traversable cells are
  moved by `relocate_invalid_positions`. `_reconcile_map` runs it on every
  snapshot and before commands, under the world-stream lock, and publishes
  ordered `player.respawned` events. Accounts and IDs survive.
- `normalize_mobs` (`backend/app/mobs.py`) rewrites legacy mob rows in place.
  Stranded mobs move to a free safe cell, and hunter and brute rows become
  `basic` with health capped at 3. `ranged` rows are kept. Nothing is deleted.
- Transport protocol and schema versions are unchanged. `worldSync.ts`
  ignores the retired live frames (`RETIRED_FRAMES`: `specialStatus`,
  `powerUpStatus`, `nitroStatus`, `treasureHunt`) from older replicas during
  a rolling deploy. Legacy snapshot fields such as `combatRecords` are ignored.
- `PROJECTILE_ACTIONS` is now only `player.shoot`. It may trail the position
  revision by `PROJECTILE_REVISION_LAG` (8); movement and facing still need the
  exact `expectedRevision`. Cosmetic `player.avatar` saves need no position revision or active life. `player.shoot` may carry an optional `facing`
  (validated); without it the stored facing is used.

Shared-data Preview would run this branch's relocation and mob loop against live
production players. Review it in isolated mode instead (see `preview.md`).

## October 7 baseline (Issue #151)

Gameplay is the end-of-Wednesday October 7 tree (`70c0042`) plus avatar saves
while defeated, the atomic grid hidden below 150% zoom, four-square entrances,
and the balanced obstacle layout. Removed after that baseline, and not present
in active code: the 98×98 expansion, space/lunar world, boss, ghosts, phasing,
jump scares, laser recoil, player-count mob scaling, and tall tree canopies.
Wednesday movement, sprint, combat, ranged enemies, respawn, and multiplayer
stay. Transport is schema 2 again. See `deployment.md` for the 0038 rollout.
Do not merge [PR #271](https://github.com/Party-Community/party-conquest/pull/271)
into this baseline; it still carries the graphics menu and space-era integration.

## Ranged mobs (Issue #102)

`backend/app/mobs.py` spawns `ranged` mobs for `population_target // 2` slots
(1 of 3 solo, 2 of 4 otherwise); the rest stay melee `basic`. Tuning:

| Value | Setting |
|---|---|
| Firing line | any angle, open terrain between, up to 32 cells (`RANGED_RANGE`) |
| Wind-up | 0.8 s (`WINDUP_SECONDS`), shown as `windingUp` on the mob |
| Projectile | rocket, 50 cells/s using elapsed server time; physics scheduled every 50 ms while shots are in flight; no range limit |
| Cooldown | 3 s from launch (`RANGED_COOLDOWN_SECONDS`) |

Wind-ups live on the mob row (`windup_until`). Projectiles in flight live in
`world_mob_states.projectiles` (jsonb, migration 0030): they belong to the
world, so a shot outlives its defeated shooter and one mob can have several
out on long misses. Every `mob.tick` payload carries the full `projectiles`
list and snapshots carry `state.mobProjectiles`, so a reconnect resyncs without
replaying shots. Rockets move before mob AI each tick. Each complete flight
segment is swept against circular player hitboxes (0.65-cell combined radius)
and solid tile bounds expanded by the 0.15-cell rocket radius. The first
collision wins, including on diagonals or delayed ticks; terrain wins ties.
Flight coordinates are fractional and the launch direction (`dx`, `dy`) is
normalized and fixed. Old cardinal projectiles are still readable.

A lost target (defeated or disconnected) cancels a wind-up with no shot. Launch
always aims at the target's current position; any newly intervening terrain
still stops the rocket. Visible targets within 32 cells take priority over
pursuing a player behind cover. Idle AI runs at most every 400 ms. Movement is
one cell every `0.8 / 1.5` seconds (about 533 ms, Issue #114), shared by both
enemy types, existing rows, new spawns, and replacements. The tick gate wakes
at pending movement deadlines even between idle AI or projectile ticks.
Ordinary sweep lateness (up to 50 ms) preserves the previous movement deadline;
long pauses or blocked movement restart the cadence without catch-up steps.
`test_mobs.py` measures both kinds over 12 seconds through real PostgreSQL
writes and the tick gate with the world loop's 25 ms sweeps, with and without
projectiles. Melee, wind-up, projectile, spawn, and respawn tuning is unchanged.

User feedback on 2026-10-02 removed the projectile range limit, then requested
much longer acquisition range, tenfold speed (5 to 50 cells/s), and a rocket
appearance. The client accepts fractional positions, rotates the rocket along
its velocity, and predicts at most 50 ms forward, stopping prediction at terrain.
It no longer renders flight a full 400 ms behind the server's collision checks.
The 0.8-second visible wind-up and three-second post-launch cooldown remain.

Rocket friendly fire deals one damage to the first mob on the swept path and
consumes that rocket; the firing mob is excluded. Three hits defeat a healthy
mob, with the existing hit/defeat visuals and no rewards. A mob killed during
physics cannot move or fire later in that tick.

Every ranged death, whether caused by a player or friendly fire, queues its
own replacement deadline ten seconds later (`ranged_respawns`, migration 0031).
These slots remain empty during the delay, including across restarts. A due
replacement uses safe spawning and the current population cap, bypassing the
ordinary six-second spawn cadence; no living players or no safe cell can defer it.
