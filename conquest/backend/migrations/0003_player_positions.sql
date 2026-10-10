-- Server-authoritative player positions with collision-free world occupancy.
CREATE TABLE IF NOT EXISTS player_positions (
    world_id   text NOT NULL,
    player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    x          integer NOT NULL CHECK (x >= 0 AND x < 256),
    y          integer NOT NULL CHECK (y >= 0 AND y < 256),
    revision   bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, player_id),
    UNIQUE (world_id, x, y)
);
