-- Space state belongs to a life: elimination deletes it atomically with the position.
CREATE TABLE player_space_states (
    world_id text NOT NULL,
    player_id uuid NOT NULL,
    kills integer NOT NULL DEFAULT 0 CHECK (kills >= 0),
    parallel boolean NOT NULL DEFAULT false,
    arrival_hole integer,
    protected_hole integer,
    jump_started_at timestamptz,
    slowed boolean NOT NULL DEFAULT false,
    last_move_at timestamptz,
    PRIMARY KEY (world_id, player_id),
    FOREIGN KEY (world_id, player_id) REFERENCES player_positions(world_id, player_id) ON DELETE CASCADE
);
CREATE TABLE world_space_cycles (
    world_id text PRIMARY KEY REFERENCES world_streams(world_id) ON DELETE CASCADE,
    holes jsonb NOT NULL DEFAULT '[]',
    next_cycle_at timestamptz NOT NULL DEFAULT now()
);
