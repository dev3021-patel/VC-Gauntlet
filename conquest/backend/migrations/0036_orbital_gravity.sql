-- Fractional movement credit survives replica handoffs; long gaps never cause catch-up bursts.
ALTER TABLE player_space_states ADD COLUMN pull_at timestamptz;
ALTER TABLE player_space_states ADD COLUMN pull_credit double precision NOT NULL DEFAULT 0;
ALTER TABLE player_space_states ADD COLUMN pull_source text;
