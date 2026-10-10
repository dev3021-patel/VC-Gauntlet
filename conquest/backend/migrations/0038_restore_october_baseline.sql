-- Return stored gameplay to the flat 80x80 baseline after migrations 0033-0037.
-- Those files stay applied and their tables stay in place. Accounts, avatar
-- claims, uploads, and combat history are not deleted. A defeated player has
-- no player_positions row, and this migration never inserts one.
--
-- Living players, mobs, and leftover pickups outside 0-79 (the retired
-- expansion and the lunar atlas at x >= 128) move into the open northern lane
-- (x 1-56, y 1-5), skipping the tree at (4, 5) and cells already in range.
-- Terrain that is in range but no longer walkable is still reconciled by
-- relocate_invalid_positions and normalize_mobs on the next snapshot or tick.

UPDATE world_mobs
SET kind = CASE WHEN kind IN ('basic', 'ranged') THEN kind ELSE 'basic' END,
    health = LEAST(health, 3),
    max_health = 3
WHERE kind NOT IN ('basic', 'ranged') OR health > 3 OR max_health IS DISTINCT FROM 3;

-- Baseline population is at most four mobs per world. Keep ranged rows first.
DELETE FROM world_mobs
WHERE id IN (
    SELECT id FROM (
        SELECT id, row_number() OVER (
            PARTITION BY world_id
            ORDER BY CASE WHEN kind = 'ranged' THEN 0 ELSE 1 END, id
        ) AS n
        FROM world_mobs
    ) ranked
    WHERE n > 4
);

ALTER TABLE world_mobs DROP CONSTRAINT IF EXISTS world_mobs_kind_check;
ALTER TABLE world_mobs
    ADD CONSTRAINT world_mobs_kind_check CHECK (kind IN ('basic', 'ranged'));

UPDATE player_positions SET phase_until = NULL WHERE phase_until IS NOT NULL;

UPDATE world_mob_states
SET ghost_pickup_x = NULL, ghost_pickup_y = NULL
WHERE ghost_pickup_x IS NOT NULL OR ghost_pickup_y IS NOT NULL;

CREATE TEMP TABLE baseline_safe_cells (x integer NOT NULL, y integer NOT NULL) ON COMMIT DROP;
INSERT INTO baseline_safe_cells(x, y)
SELECT x, y
FROM generate_series(1, 56) AS x
CROSS JOIN generate_series(1, 5) AS y
WHERE NOT (x = 4 AND y = 5);

CREATE TEMP TABLE baseline_moves (
    world_id text NOT NULL,
    entity text NOT NULL,
    entity_id text NOT NULL,
    x integer NOT NULL,
    y integer NOT NULL
) ON COMMIT DROP;

INSERT INTO baseline_moves(world_id, entity, entity_id, x, y)
WITH stranded AS (
    SELECT world_id, 'gold'::text AS entity, id::text AS entity_id
    FROM gold_drops
    WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
    UNION ALL
    SELECT world_id, 'grenade', id::text
    FROM heavy_grenade_drops
    WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
    UNION ALL
    SELECT world_id, 'mob', id::text
    FROM world_mobs
    WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
    UNION ALL
    SELECT world_id, 'player', player_id::text
    FROM player_positions
    WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
    UNION ALL
    SELECT world_id, 'web', web_id
    FROM world_webs
    WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
       OR origin_x < 0 OR origin_y < 0 OR origin_x >= 80 OR origin_y >= 80
),
numbered AS (
    SELECT world_id, entity, entity_id,
           row_number() OVER (PARTITION BY world_id ORDER BY entity, entity_id) AS n
    FROM stranded
),
occupied AS (
    SELECT world_id, x, y FROM player_positions
    WHERE x >= 0 AND y >= 0 AND x < 80 AND y < 80
    UNION
    SELECT world_id, x, y FROM world_mobs
    WHERE x >= 0 AND y >= 0 AND x < 80 AND y < 80
),
free AS (
    SELECT worlds.world_id, cells.x, cells.y,
           row_number() OVER (PARTITION BY worlds.world_id ORDER BY cells.y, cells.x) AS n
    FROM (SELECT DISTINCT world_id FROM numbered) AS worlds
    CROSS JOIN baseline_safe_cells AS cells
    WHERE NOT EXISTS (
        SELECT 1 FROM occupied
        WHERE occupied.world_id = worlds.world_id
          AND occupied.x = cells.x
          AND occupied.y = cells.y
    )
)
SELECT numbered.world_id, numbered.entity, numbered.entity_id, free.x, free.y
FROM numbered
JOIN free ON free.world_id = numbered.world_id AND free.n = numbered.n;

DO $$
BEGIN
    IF (SELECT count(*) FROM (
            SELECT 1 FROM player_positions WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
            UNION ALL
            SELECT 1 FROM world_mobs WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
            UNION ALL
            SELECT 1 FROM gold_drops WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
            UNION ALL
            SELECT 1 FROM heavy_grenade_drops WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
            UNION ALL
            SELECT 1 FROM world_webs
            WHERE x < 0 OR y < 0 OR x >= 80 OR y >= 80
               OR origin_x < 0 OR origin_y < 0 OR origin_x >= 80 OR origin_y >= 80
        ) stranded) <> (SELECT count(*) FROM baseline_moves) THEN
        RAISE EXCEPTION 'baseline restore could not place every stranded row';
    END IF;
END $$;

UPDATE player_positions AS positions
SET x = moves.x, y = moves.y, facing = 'south', revision = revision + 1, updated_at = now()
FROM baseline_moves AS moves
WHERE moves.entity = 'player'
  AND positions.world_id = moves.world_id
  AND positions.player_id::text = moves.entity_id;

UPDATE world_mobs AS mobs
SET x = moves.x, y = moves.y, revision = revision + 1
FROM baseline_moves AS moves
WHERE moves.entity = 'mob'
  AND mobs.world_id = moves.world_id
  AND mobs.id::text = moves.entity_id;

UPDATE gold_drops AS drops
SET x = moves.x, y = moves.y
FROM baseline_moves AS moves
WHERE moves.entity = 'gold'
  AND drops.world_id = moves.world_id
  AND drops.id::text = moves.entity_id;

UPDATE heavy_grenade_drops AS drops
SET x = moves.x, y = moves.y
FROM baseline_moves AS moves
WHERE moves.entity = 'grenade'
  AND drops.world_id = moves.world_id
  AND drops.id::text = moves.entity_id;

UPDATE world_webs AS webs
SET x = CASE WHEN webs.x < 0 OR webs.y < 0 OR webs.x >= 80 OR webs.y >= 80 THEN moves.x ELSE webs.x END,
    y = CASE WHEN webs.x < 0 OR webs.y < 0 OR webs.x >= 80 OR webs.y >= 80 THEN moves.y ELSE webs.y END,
    origin_x = CASE
        WHEN webs.origin_x IS NULL THEN NULL
        WHEN webs.origin_x < 0 OR webs.origin_y < 0 OR webs.origin_x >= 80 OR webs.origin_y >= 80 THEN moves.x
        ELSE webs.origin_x
    END,
    origin_y = CASE
        WHEN webs.origin_y IS NULL THEN NULL
        WHEN webs.origin_x < 0 OR webs.origin_y < 0 OR webs.origin_x >= 80 OR webs.origin_y >= 80 THEN moves.y
        ELSE webs.origin_y
    END
FROM baseline_moves AS moves
WHERE moves.entity = 'web'
  AND webs.world_id = moves.world_id
  AND webs.web_id = moves.entity_id;

ALTER TABLE player_positions
    DROP CONSTRAINT player_positions_y_check,
    ADD CONSTRAINT player_positions_y_check CHECK (y >= 0 AND y < 80);
ALTER TABLE gold_drops
    DROP CONSTRAINT gold_drops_y_check,
    ADD CONSTRAINT gold_drops_y_check CHECK (y >= 0 AND y < 80);
ALTER TABLE world_mobs
    DROP CONSTRAINT world_mobs_y_check,
    ADD CONSTRAINT world_mobs_y_check CHECK (y >= 0 AND y < 80);
ALTER TABLE world_webs
    DROP CONSTRAINT world_webs_y_check,
    ADD CONSTRAINT world_webs_y_check CHECK (y >= 0 AND y < 80),
    DROP CONSTRAINT world_webs_origin_x_check,
    ADD CONSTRAINT world_webs_origin_x_check CHECK (origin_x IS NULL OR (origin_x >= 0 AND origin_x < 80)),
    DROP CONSTRAINT world_webs_origin_y_check,
    ADD CONSTRAINT world_webs_origin_y_check CHECK (origin_y IS NULL OR (origin_y >= 0 AND origin_y < 80));
ALTER TABLE heavy_grenade_drops
    DROP CONSTRAINT heavy_grenade_drops_y_check,
    ADD CONSTRAINT heavy_grenade_drops_y_check CHECK (y >= 0 AND y < 80);

UPDATE schema_contract SET value = 5 WHERE key = 'coordinate_version';
