-- Player-scaled mobs: hunter and brute variants, plus a sticky pursuit target.
-- Existing basic mobs stay until defeated; nothing is despawned by this change.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'world_mobs' AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%kind%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE world_mobs DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE world_mobs
  ADD CONSTRAINT world_mobs_kind_check CHECK (kind IN ('basic', 'hunter', 'brute'));

ALTER TABLE world_mobs
  ADD COLUMN target_player_id uuid;
