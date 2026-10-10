-- Move the existing 40x40 world into the lower-right quadrant while widening
-- every persisted coordinate contract in the same transaction. Relative
-- positions, identities, progression, and pickup expiry timestamps are kept.
ALTER TABLE player_positions
    DROP CONSTRAINT player_positions_x_check,
    DROP CONSTRAINT player_positions_y_check;

ALTER TABLE gold_drops
    DROP CONSTRAINT gold_drops_x_check,
    DROP CONSTRAINT gold_drops_y_check;

UPDATE player_positions SET x = x + 40, y = y + 40;
UPDATE gold_drops SET x = x + 40, y = y + 40;
UPDATE world_powerup_cycles SET chest_x = chest_x + 40, chest_y = chest_y + 40
WHERE state = 'chest';

ALTER TABLE player_positions
    ADD CONSTRAINT player_positions_x_check CHECK (x >= 0 AND x < 80),
    ADD CONSTRAINT player_positions_y_check CHECK (y >= 0 AND y < 80);

ALTER TABLE gold_drops
    ADD CONSTRAINT gold_drops_x_check CHECK (x >= 0 AND x < 80),
    ADD CONSTRAINT gold_drops_y_check CHECK (y >= 0 AND y < 80);

UPDATE schema_contract SET value=4 WHERE key='coordinate_version';
