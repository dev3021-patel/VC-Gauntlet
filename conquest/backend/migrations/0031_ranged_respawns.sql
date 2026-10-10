-- Preserve each defeated ranged mob's ten-second replacement delay across restarts.
ALTER TABLE world_mob_states
  ADD COLUMN ranged_respawns timestamptz[] NOT NULL DEFAULT ARRAY[]::timestamptz[];
