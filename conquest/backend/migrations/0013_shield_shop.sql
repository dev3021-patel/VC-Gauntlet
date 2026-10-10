ALTER TABLE player_progression ADD COLUMN shield_charges integer NOT NULL DEFAULT 0
  CHECK (shield_charges BETWEEN 0 AND 3);
-- Carried balances are bigint; a pile must accommodate the same value plus a coin.
ALTER TABLE gold_drops ALTER COLUMN value TYPE bigint;
