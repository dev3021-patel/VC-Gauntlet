-- Expand the shared map from 80x80 to 98x98 (Issue #116). The existing grid
-- keeps its coordinates and the new squares are appended east and south, so
-- no stored position, pickup, mob, web, or chest is translated. x checks were
-- already widened to 485 by 0026; only the row bounds and web origins change.
ALTER TABLE player_positions
    DROP CONSTRAINT player_positions_y_check,
    ADD CONSTRAINT player_positions_y_check CHECK (y >= 0 AND y < 98);

ALTER TABLE gold_drops
    DROP CONSTRAINT gold_drops_y_check,
    ADD CONSTRAINT gold_drops_y_check CHECK (y >= 0 AND y < 98);

ALTER TABLE world_mobs
    DROP CONSTRAINT world_mobs_y_check,
    ADD CONSTRAINT world_mobs_y_check CHECK (y >= 0 AND y < 98);

ALTER TABLE world_webs
    DROP CONSTRAINT world_webs_y_check,
    ADD CONSTRAINT world_webs_y_check CHECK (y >= 0 AND y < 98),
    DROP CONSTRAINT world_webs_origin_x_check,
    ADD CONSTRAINT world_webs_origin_x_check CHECK (origin_x IS NULL OR (origin_x >= 0 AND origin_x < 98)),
    DROP CONSTRAINT world_webs_origin_y_check,
    ADD CONSTRAINT world_webs_origin_y_check CHECK (origin_y IS NULL OR (origin_y >= 0 AND origin_y < 98));

ALTER TABLE heavy_grenade_drops
    DROP CONSTRAINT heavy_grenade_drops_y_check,
    ADD CONSTRAINT heavy_grenade_drops_y_check CHECK (y >= 0 AND y < 98);

UPDATE schema_contract SET value=6 WHERE key='coordinate_version';
