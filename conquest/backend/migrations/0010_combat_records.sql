-- Persistent account-level combat prestige. Existing history is intentionally not backfilled.

CREATE TABLE combat_records (
    player_id      uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    kills          bigint NOT NULL DEFAULT 0 CHECK (kills >= 0),
    deaths         bigint NOT NULL DEFAULT 0 CHECK (deaths >= 0),
    current_streak bigint NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO combat_records(player_id)
SELECT id FROM players
ON CONFLICT (player_id) DO NOTHING;
