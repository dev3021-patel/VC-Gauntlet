-- Forward-only recovery from the prematurely applied movement-block migration.
-- Accounts, authentication tokens, and any low-coordinate positions created
-- after 0004 are preserved. The redundant per-row version column is removed;
-- schema_contract below is the single authoritative coordinate-model marker.
ALTER TABLE player_positions
    DROP CONSTRAINT player_positions_x_check,
    DROP CONSTRAINT player_positions_y_check,
    DROP COLUMN coordinate_version,
    ADD CONSTRAINT player_positions_x_check CHECK (x >= 0 AND x < 256),
    ADD CONSTRAINT player_positions_y_check CHECK (y >= 0 AND y < 256);

CREATE TABLE IF NOT EXISTS schema_contract (
    key   text PRIMARY KEY,
    value integer NOT NULL
);

INSERT INTO schema_contract(key, value) VALUES ('coordinate_version', 1)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
