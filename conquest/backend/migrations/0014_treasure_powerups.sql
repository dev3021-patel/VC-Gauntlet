CREATE TABLE world_powerup_cycles (
  world_id text PRIMARY KEY REFERENCES world_streams(world_id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'cooldown' CHECK (state IN ('cooldown', 'chest', 'claimed')),
  available_at timestamptz,
  chest_x integer,
  chest_y integer,
  holder_id uuid REFERENCES players(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'cooldown' AND available_at IS NOT NULL AND chest_x IS NULL AND chest_y IS NULL AND holder_id IS NULL)
      OR (state = 'chest' AND available_at IS NULL AND chest_x IS NOT NULL AND chest_y IS NOT NULL AND holder_id IS NULL)
      OR (state = 'claimed' AND available_at IS NULL AND chest_x IS NULL AND chest_y IS NULL AND holder_id IS NOT NULL))
);

CREATE TABLE player_powerups (
  world_id text NOT NULL,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('shield', 'speed')),
  awarded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, player_id),
  FOREIGN KEY (world_id) REFERENCES world_streams(world_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX one_world_powerup_holder ON player_powerups(world_id);

CREATE TABLE player_speed_effects (
  world_id text NOT NULL,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  active_until timestamptz NOT NULL,
  PRIMARY KEY (world_id, player_id),
  FOREIGN KEY (world_id) REFERENCES world_streams(world_id) ON DELETE CASCADE
);
