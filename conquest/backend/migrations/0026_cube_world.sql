-- Widen every persisted coordinate to the six-face cube atlas (x 0-484, y 0-79).
-- Face 0 keeps columns 0-79, so existing positions, pickups, mobs, and chests
-- stay exactly where they are on the retained map; nothing is translated.
ALTER TABLE player_positions
    DROP CONSTRAINT player_positions_x_check,
    ADD CONSTRAINT player_positions_x_check CHECK (x >= 0 AND x < 485);

ALTER TABLE gold_drops
    DROP CONSTRAINT gold_drops_x_check,
    ADD CONSTRAINT gold_drops_x_check CHECK (x >= 0 AND x < 485);

ALTER TABLE world_mobs
    DROP CONSTRAINT world_mobs_x_check,
    ADD CONSTRAINT world_mobs_x_check CHECK (x >= 0 AND x < 485);

ALTER TABLE world_webs
    DROP CONSTRAINT world_webs_x_check,
    ADD CONSTRAINT world_webs_x_check CHECK (x >= 0 AND x < 485);

ALTER TABLE heavy_grenade_drops
    DROP CONSTRAINT heavy_grenade_drops_x_check,
    ADD CONSTRAINT heavy_grenade_drops_x_check CHECK (x >= 0 AND x < 485);

UPDATE schema_contract SET value=5 WHERE key='coordinate_version';
