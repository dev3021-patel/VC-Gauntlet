-- Adopt the finalized 32x32 movement-block coordinate model after the
-- forward recovery in 0005. Existing terrain-cell positions cannot be
-- interpreted safely as blocks, so players are re-placed on next connection.
DELETE FROM player_positions;

ALTER TABLE player_positions
    DROP CONSTRAINT player_positions_x_check,
    DROP CONSTRAINT player_positions_y_check,
    ADD CONSTRAINT player_positions_x_check CHECK (x >= 0 AND x < 32),
    ADD CONSTRAINT player_positions_y_check CHECK (y >= 0 AND y < 32);

INSERT INTO schema_contract(key, value) VALUES ('coordinate_version', 2)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
