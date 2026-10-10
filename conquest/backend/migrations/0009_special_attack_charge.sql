-- Persistent, server-authoritative special-attack charge and connection presence.
CREATE TABLE player_special_charges (
    world_id      text NOT NULL,
    player_id     uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    accumulated_ms bigint NOT NULL DEFAULT 0 CHECK (accumulated_ms BETWEEN 0 AND 30000),
    active_since  timestamptz,
    PRIMARY KEY (world_id, player_id)
);

CREATE TABLE player_world_connections (
    connection_id uuid PRIMARY KEY,
    world_id      text NOT NULL,
    player_id     uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    connected_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX player_world_connections_player
    ON player_world_connections(world_id, player_id);
