CREATE TABLE player_progression (
  player_id uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  total_xp bigint NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  gold bigint NOT NULL DEFAULT 0 CHECK (gold >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO player_progression(player_id)
SELECT id FROM players
ON CONFLICT DO NOTHING;

CREATE TABLE gold_drops (
  id uuid PRIMARY KEY,
  world_id text NOT NULL,
  x integer NOT NULL CHECK (x >= 0 AND x < 40),
  y integer NOT NULL CHECK (y >= 0 AND y < 40),
  value integer NOT NULL DEFAULT 1 CHECK (value > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX gold_drops_world_expiry ON gold_drops(world_id, expires_at);
CREATE INDEX gold_drops_world_cell ON gold_drops(world_id, x, y);
