# Realtime synchronization (single world owner)

Verified 2026-10-01 against a local 100-player load run.

- Production injects the database pool into `PostgresWorldStore`, which skips
  `SCHEMA_SQL` bootstrap DDL. All production tables must have migrations.
  Migration 0029 creates `world_owner_epoch` without resetting an existing
  fencing epoch. The migration regression test starts an exclusive store using
  an injected pool after applying migrations in a disposable schema.

- One backend process owns live worlds: it holds
  `pg_try_advisory_lock(hashtext('party_conquest_world_owner:' || schema))` on a
  dedicated connection. Production runs 1 replica with `Recreate` deploys, so a
  rollout is a brief outage. `WORLD_OWNERSHIP=shared` disables ownership;
  `scripts/run-preview.sh` sets it for shared previews so they never compete
  with production.
- `app/realtime.py` `WorldRuntime` commits ordinary `player.move`, `player.face`,
  and **missed** normal `player.shoot` in memory (socket `type:"command"`).
  Anything with a side effect (a shot that could hit a player or mob, unknown
  players) returns `None` and takes the database resolver.
  `tests/test_realtime.py` pins in-memory miss payloads to the resolver's.
  Both honor a shot's optional `facing` through `shot_facing`; a lane crossing
  any cached player or mob cell goes to the resolver. The 1 s shot cooldown is
  checked by the store before either path (`combat-laser.md`).
- Revisions are assigned at flush, under the `world_streams` row lock. Every 50 ms
  the tick writes one batch with `FLUSH_QUERY` (guarded by `stored_revision`), sends
  one `pg_notify` `{worldId, from, revision}`, and broadcasts one `batch` frame.
  Routine flushes hold only `runtime.flushing`; database-path commands and reloads
  hold `runtime.lock`, which live commands wait on.
- The fast path does not write `world_commands` idempotency rows.
- `app/ws_compression.py` forces `server_no_context_takeover` and reuses compressed
  bytes for identical frames; per-socket deflate had been ~50% of CPU at 100 players.
- Mob pursuit BFS stops after the depth where a target is first found.
- Taunts (Issue #106) are live-only socket frames `{type:"taunt", worldId}`.
  The socket accepts one only from an authenticated actor with registered
  presence; `publish_taunt` requires a `player_positions` row (defeat deletes
  it) and fans out `{type:"taunt", worldId, playerId}` with no revision: local
  `_deliver` when exclusive, `pg_notify` `{worldId, transient}` when shared.
  `_send_stream_item` forwards it without touching the replay cursor. Taunts
  never enter `world_events`, snapshots, or replay.
- Held keyboard movement retimes rather than steps on a Shift change: the next
  repeat is due `lastStep + cadence`, so sprint toggles never add or drop a move.

## Load testing

Never add a load harness to the repo or CI. A throwaway harness ran from `/tmp`
against a local pgserver database (see `testing.md`). With 100 socket players
stepping every 80 ms and shooting on ~30% of turns on a shared 4-CPU host:
moves and shots p50 ~100 ms and p95 ~220 ms (it was p50 ~300 ms before), with
no unanswered commands. Hits still serialize per world on the database path
(roughly 15/s), and every player still receives every event (no interest
management). Harness players must stop sending input once defeated, as the real
client does; otherwise `not_active` retries dominate the lock.
