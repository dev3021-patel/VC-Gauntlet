-- Extend the shared combat-record baseline; never recreate or reset its counters.
ALTER TABLE combat_records
    ADD COLUMN spread_earned boolean NOT NULL DEFAULT false,
    ADD COLUMN spread_expires_at timestamptz,
    ADD CONSTRAINT spread_reward_requires_eligibility
        CHECK (spread_earned OR spread_expires_at IS NULL);
