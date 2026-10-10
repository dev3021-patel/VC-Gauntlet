-- Server-authoritative enemy mobs. One row per living mob plus per-world AI
-- timing so every backend replica shares the same spawn and tick schedule.
CREATE TABLE world_mob_states (
    world_id      text PRIMARY KEY REFERENCES world_streams(world_id) ON DELETE CASCADE,
    next_tick_at  timestamptz NOT NULL DEFAULT now(),
    next_spawn_at timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE world_mobs (
    id             uuid PRIMARY KEY,
    world_id       text NOT NULL REFERENCES world_streams(world_id) ON DELETE CASCADE,
    kind           text NOT NULL DEFAULT 'basic' CHECK (kind IN ('basic')),
    x              integer NOT NULL CHECK (x >= 0 AND x < 80),
    y              integer NOT NULL CHECK (y >= 0 AND y < 80),
    facing         text NOT NULL DEFAULT 'south' CHECK (facing IN ('north', 'south', 'west', 'east')),
    health         integer NOT NULL CHECK (health > 0),
    revision       bigint NOT NULL CHECK (revision >= 1),
    next_move_at   timestamptz NOT NULL DEFAULT now(),
    next_attack_at timestamptz NOT NULL DEFAULT now(),
    spawned_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, x, y)
);

CREATE INDEX world_mobs_world ON world_mobs(world_id, id);
