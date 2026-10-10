-- Ghost enemies and the ghost phasing power-up (Issue #126). Additive only:
-- existing mobs, positions, and world state are untouched.
-- Ghosts come in a slow common tier and a fast rare tier.
ALTER TABLE world_mobs DROP CONSTRAINT IF EXISTS world_mobs_kind_check;
ALTER TABLE world_mobs
  ADD CONSTRAINT world_mobs_kind_check CHECK (kind IN ('basic', 'hunter', 'brute', 'ranged', 'ghost_slow', 'ghost_fast'));

-- At most one uncollected pickup per world, replaced on every cycle. A world
-- that becomes active receives its first pickup straight away.
ALTER TABLE world_mob_states
  ADD COLUMN ghost_pickup_x integer CHECK (ghost_pickup_x >= 0 AND ghost_pickup_x < 98),
  ADD COLUMN ghost_pickup_y integer CHECK (ghost_pickup_y >= 0 AND ghost_pickup_y < 98),
  ADD COLUMN next_ghost_pickup_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT world_mob_states_ghost_pickup_check CHECK ((ghost_pickup_x IS NULL) = (ghost_pickup_y IS NULL));

-- The phasing effect lives with the position, so a death (which deletes the
-- row) clears it, a new life starts without it, and a reconnect keeps the
-- original expiry.
ALTER TABLE player_positions ADD COLUMN phase_until timestamptz;
