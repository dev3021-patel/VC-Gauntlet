-- Web ammo belongs to a life: a new position row starts full, and death deletes it.
ALTER TABLE player_positions
  ADD COLUMN web_shots integer NOT NULL DEFAULT 3 CHECK (web_shots >= 0);

-- Short-lived 3x3 web areas centred on (x, y). Rows past expires_at are inert
-- and are swept by the next throw in the same world.
CREATE TABLE world_webs (
  world_id text NOT NULL REFERENCES world_streams(world_id) ON DELETE CASCADE,
  web_id text NOT NULL,
  owner_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  x integer NOT NULL CHECK (x >= 0 AND x < 80),
  y integer NOT NULL CHECK (y >= 0 AND y < 80),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (world_id, web_id)
);
CREATE INDEX world_webs_active ON world_webs (world_id, expires_at);
