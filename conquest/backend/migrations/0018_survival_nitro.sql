-- Server-authoritative survival-charged Nitro: one tank and one burst deadline per life.
-- charge_started_at is the moment the current continuous-survival charge began
-- (NULL while dead or disconnected); active_until is the current burst deadline.
CREATE TABLE player_nitro (
  world_id text NOT NULL,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  charge_started_at timestamptz,
  active_until timestamptz,
  PRIMARY KEY (world_id, player_id),
  FOREIGN KEY (world_id) REFERENCES world_streams(world_id) ON DELETE CASCADE
);
