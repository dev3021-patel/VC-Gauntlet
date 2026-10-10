-- Persistent Heavy grenades. Existing Standard counts and refill rules stay untouched.
ALTER TABLE combat_records
  ADD COLUMN heavy_grenades integer NOT NULL DEFAULT 0
  CHECK (heavy_grenades >= 0 AND heavy_grenades <= 3);

-- One visible pickup per successful mob-defeat roll. Claimed by walking onto the cell.
CREATE TABLE heavy_grenade_drops (
  id uuid PRIMARY KEY,
  world_id text NOT NULL,
  x integer NOT NULL CHECK (x >= 0 AND x < 80),
  y integer NOT NULL CHECK (y >= 0 AND y < 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX heavy_grenade_drops_world_expiry ON heavy_grenade_drops(world_id, expires_at);
CREATE INDEX heavy_grenade_drops_world_cell ON heavy_grenade_drops(world_id, x, y);
