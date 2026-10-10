-- Persist which shop shield is equipped so clients never infer Shield versus
-- Super Shield from the remaining charge count.
ALTER TABLE player_progression ADD COLUMN shield_kind text
  CHECK (shield_kind IN ('shield', 'super_shield'));
-- One-time backfill for protection bought before the kind was recorded.
UPDATE player_progression
   SET shield_kind = CASE WHEN shield_charges > 1 THEN 'super_shield' ELSE 'shield' END
 WHERE shield_charges > 0;
ALTER TABLE player_progression ADD CONSTRAINT shield_kind_matches_charges
  CHECK ((shield_charges = 0) = (shield_kind IS NULL));
