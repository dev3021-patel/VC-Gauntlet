-- Replace legacy 256x256 terrain-cell positions with 32x32 movement blocks.
-- Existing positions cannot be interpreted safely in the new coordinate space,
-- so players are re-placed on their next connection.
DELETE FROM player_positions;

ALTER TABLE player_positions
    DROP CONSTRAINT player_positions_x_check,
    DROP CONSTRAINT player_positions_y_check,
    ADD COLUMN coordinate_version smallint NOT NULL DEFAULT 2 CHECK (coordinate_version = 2),
    ADD CONSTRAINT player_positions_x_check CHECK (x >= 0 AND x < 32),
    ADD CONSTRAINT player_positions_y_check CHECK (y >= 0 AND y < 32);
