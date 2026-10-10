-- Extend deployed combat records without resetting account prestige.
ALTER TABLE combat_records
  ADD COLUMN grenades integer NOT NULL DEFAULT 3 CHECK (grenades >= 0),
  ADD COLUMN grenade_refill_earned boolean NOT NULL DEFAULT false;

-- Existing high streaks get the baseline, never a retroactive refill.
UPDATE combat_records SET grenade_refill_earned=true WHERE current_streak >= 10;
