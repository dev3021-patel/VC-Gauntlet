-- Persist each mob's spawn-time maximum so later player-count changes do not rescale it.
ALTER TABLE world_mobs ADD COLUMN max_health integer;
UPDATE world_mobs SET max_health = GREATEST(health, 3);
ALTER TABLE world_mobs ALTER COLUMN max_health SET NOT NULL;
ALTER TABLE world_mobs ALTER COLUMN max_health SET DEFAULT 3;
ALTER TABLE world_mobs ADD CONSTRAINT world_mobs_max_health_check CHECK (max_health > 0);
