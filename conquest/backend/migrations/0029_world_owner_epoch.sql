-- Exclusive-mode fencing token: each new world owner increments it, and every
-- owner write re-reads it FOR SHARE inside its own transaction. Production
-- starts the world store on a shared pool, which skips the transport's
-- startup DDL, so the table must come from a migration.
CREATE TABLE IF NOT EXISTS world_owner_epoch (
  singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  epoch bigint NOT NULL
);
