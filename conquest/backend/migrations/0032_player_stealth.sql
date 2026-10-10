-- Player stealth (Issue #104). The flags live with the position, so a death
-- (which deletes the row) or a new life always starts visible. pace is an
-- exponentially decayed count of recent committed moves, measured at pace_at
-- (Unix epoch seconds); mobs derive a stealthed player's detection radius
-- from it. stealth_detected is the last authoritative "an enemy can see you"
-- result, kept so clients agree after a reconnect.
ALTER TABLE player_positions
  ADD COLUMN IF NOT EXISTS stealth boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stealth_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pace double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pace_at double precision NOT NULL DEFAULT 0;
