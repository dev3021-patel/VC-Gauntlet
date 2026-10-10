-- Durable ordering, idempotency, and replay state for shared-world transport.
CREATE TABLE IF NOT EXISTS world_streams (
  world_id text PRIMARY KEY,
  current_revision bigint NOT NULL DEFAULT 0,
  oldest_revision bigint NOT NULL DEFAULT 1,
  CHECK (current_revision >= 0),
  CHECK (oldest_revision >= 1)
);

CREATE TABLE IF NOT EXISTS world_commands (
  world_id text NOT NULL,
  command_id text NOT NULL,
  content_hash text NOT NULL,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, command_id)
);

CREATE TABLE IF NOT EXISTS world_events (
  world_id text NOT NULL,
  revision bigint NOT NULL,
  event jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, revision)
);

CREATE INDEX IF NOT EXISTS world_events_committed_at ON world_events (committed_at);
