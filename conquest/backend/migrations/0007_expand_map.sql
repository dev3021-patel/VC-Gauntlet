-- Keep existing block coordinates and identities; only expand the bounds.
-- The world snapshot reconciles blocked positions under the world lock and
-- publishes ordered respawn events. Valid positions are never reset.
ALTER TABLE player_positions
    DROP CONSTRAINT player_positions_x_check,
    DROP CONSTRAINT player_positions_y_check,
    ADD CONSTRAINT player_positions_x_check CHECK (x >= 0 AND x < 40),
    ADD CONSTRAINT player_positions_y_check CHECK (y >= 0 AND y < 40);

UPDATE schema_contract SET value=3 WHERE key='coordinate_version';
