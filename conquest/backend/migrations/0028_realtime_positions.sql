-- Realtime movement: facing is stored with the position instead of being
-- re-derived from the event log, and cell uniqueness is checked at the end of
-- each statement so one batched UPDATE can apply chained moves (A leaves a
-- cell that B enters in the same flush).
ALTER TABLE player_positions ADD COLUMN IF NOT EXISTS facing text NOT NULL DEFAULT 'south'
  CHECK (facing IN ('north', 'south', 'east', 'west'));

UPDATE player_positions pp SET facing = latest.facing
FROM (
  SELECT DISTINCT ON (world_id, event->'payload'->>'playerId')
         world_id, event->'payload'->>'playerId' player_id, event->'payload'->>'facing' facing
  FROM world_events
  WHERE event->>'eventType' IN ('player.placed', 'player.moved', 'player.respawned', 'player.faced')
    AND event->'payload'->>'facing' IN ('north', 'south', 'east', 'west')
  ORDER BY world_id, event->'payload'->>'playerId', revision DESC
) latest
WHERE pp.world_id = latest.world_id AND pp.player_id::text = latest.player_id;

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'player_positions' AND rel.relnamespace = current_schema()::regnamespace
    AND con.contype = 'u';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE player_positions DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE player_positions
  ADD CONSTRAINT player_positions_world_cell UNIQUE (world_id, x, y) DEFERRABLE INITIALLY IMMEDIATE;
