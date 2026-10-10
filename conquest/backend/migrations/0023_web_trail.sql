-- A web also covers the straight line from where it was thrown. Null origins
-- are landing-only webs created before this column existed.
ALTER TABLE world_webs
  ADD COLUMN origin_x integer CHECK (origin_x IS NULL OR (origin_x >= 0 AND origin_x < 80)),
  ADD COLUMN origin_y integer CHECK (origin_y IS NULL OR (origin_y >= 0 AND origin_y < 80)),
  ADD COLUMN facing text CHECK (facing IS NULL OR facing IN ('north', 'south', 'east', 'west'));
