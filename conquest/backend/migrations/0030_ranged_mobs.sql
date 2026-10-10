-- Ranged mobs (Issue #102). A ranged mob winds up, then fires one straight
-- projectile that flies until terrain, the map edge, or a player stops it.
-- Additive only: existing mobs are untouched.
ALTER TABLE world_mobs DROP CONSTRAINT IF EXISTS world_mobs_kind_check;
ALTER TABLE world_mobs
  ADD CONSTRAINT world_mobs_kind_check CHECK (kind IN ('basic', 'hunter', 'brute', 'ranged'));

ALTER TABLE world_mobs ADD COLUMN windup_until timestamptz;

-- Projectiles in flight belong to the world, so a shot keeps flying after its
-- shooter is defeated, and one mob may have several shots out on long misses.
ALTER TABLE world_mob_states ADD COLUMN projectiles jsonb NOT NULL DEFAULT '[]'::jsonb;
