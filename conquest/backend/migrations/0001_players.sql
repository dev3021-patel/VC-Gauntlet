-- Player accounts: name + 4-digit PIN, with bearer tokens for return visits.
-- Runs inside the party_conquest schema (search_path is set by the migrator).

CREATE TABLE players (
    id              uuid PRIMARY KEY,
    name            text NOT NULL,
    name_key        text NOT NULL UNIQUE,
    avatar          text NOT NULL,
    pin_salt        text NOT NULL,
    pin_hash        text NOT NULL,
    failed_attempts integer NOT NULL DEFAULT 0,
    locked_until    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE player_tokens (
    token        text PRIMARY KEY,
    player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX player_tokens_player_id_idx ON player_tokens (player_id);
