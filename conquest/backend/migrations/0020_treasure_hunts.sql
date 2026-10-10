-- Private, per-player treasure hunts: one randomized river -> fortress -> cache
-- route, the next required stage, the number of hunts completed, and the last
-- completed route so the replacement hunt can avoid repeating it. Rows are
-- never removed by death; only reaching the required landmark advances them.
CREATE TABLE player_treasure_hunts (
  world_id text NOT NULL REFERENCES world_streams(world_id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  river_landmark text NOT NULL,
  fortress_landmark text NOT NULL,
  cache_landmark text NOT NULL,
  stage integer NOT NULL DEFAULT 0 CHECK (stage >= 0 AND stage <= 2),
  completed_hunts integer NOT NULL DEFAULT 0 CHECK (completed_hunts >= 0),
  previous_route text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, player_id)
);
