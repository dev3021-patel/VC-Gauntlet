import asyncio
import os
import pathlib
import uuid

import asyncpg
import pytest
from app.db import DatabaseConfig, create_pool
from app.migrate import (
    MIGRATIONS_DIR,
    SchemaCompatibilityError,
    assert_coordinate_contract,
    assert_compatible_migrations,
    expected_migrations,
    list_migrations,
    run_migrations,
)
from app.world_transport import PostgresWorldStore
from app.player_positions import position_resolver


def test_migration_files_are_well_formed():
    migrations = list_migrations(MIGRATIONS_DIR)
    assert migrations, "expected at least one migration"
    assert [version for version, _ in migrations] == list(range(1, len(migrations) + 1))
    for _, path in migrations:
        assert path.read_text(encoding="utf-8").strip()


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL is not configured")
@pytest.mark.parametrize("existing_epoch", [None, 41])
def test_migrated_schema_starts_exclusive_transport_with_production_pool(tmp_path, existing_epoch):
    """Migration-only initialization must support the pool injected in production."""
    previous = tmp_path / "previous"
    previous.mkdir()
    for version, path in list_migrations():
        if version < 29:
            (previous / path.name).write_text(path.read_text())

    async def scenario():
        schema = "party_conquest_preview_test_" + uuid.uuid4().hex[:12]
        config = DatabaseConfig(os.environ["TEST_DATABASE_URL"], schema)
        pool = store = None
        try:
            await run_migrations(config, previous, log=lambda *_: None)
            pool = await create_pool(config)
            await pool.execute("INSERT INTO world_streams(world_id, current_revision) VALUES('preserved', 42)")
            if existing_epoch is not None:
                # A standalone store may already have bootstrapped this table.
                await pool.execute("""CREATE TABLE world_owner_epoch (
                    singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
                    epoch bigint NOT NULL
                )""")
                await pool.execute("INSERT INTO world_owner_epoch(epoch) VALUES($1)", existing_epoch)

            assert 29 in await run_migrations(config, log=lambda *_: None)
            assert await run_migrations(config, log=lambda *_: None) == []
            assert await pool.fetchval("SELECT epoch FROM world_owner_epoch") == existing_epoch
            assert await pool.fetchval(
                "SELECT current_revision FROM world_streams WHERE world_id='preserved'"
            ) == 42

            store = PostgresWorldStore(config.dsn, position_resolver, schema=schema, pool=pool, exclusive=True)
            await store.start()
            assert await store.ready()
            assert await pool.fetchval("SELECT epoch FROM world_owner_epoch") == (existing_epoch or 0) + 1
            await store.close()
            store = None
            assert await pool.fetchval("SELECT 1") == 1  # The injected pool is caller-owned.
        finally:
            if store is not None:
                await store.close()
            if pool is not None:
                await pool.close()
            connection = await asyncpg.connect(config.dsn)
            try:
                await connection.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
            finally:
                await connection.close()

    asyncio.run(scenario())


def test_bad_migration_names_are_rejected(tmp_path: pathlib.Path):
    (tmp_path / "players.sql").write_text("select 1;")
    with pytest.raises(ValueError):
        list_migrations(tmp_path)


def test_migration_history_requires_exact_versions_and_names():
    expected = expected_migrations()
    rows = [{"version": version, "name": name} for version, name in expected.items()]
    assert_compatible_migrations(rows)

    with pytest.raises(SchemaCompatibilityError, match="contract mismatch"):
        assert_compatible_migrations(rows[:-1])
    with pytest.raises(SchemaCompatibilityError, match="contract mismatch"):
        assert_compatible_migrations([*rows, {"version": 9999, "name": "9999_unknown"}])
    conflicting = [dict(row) for row in rows]
    conflicting[3]["name"] = "0004_different_branch"
    with pytest.raises(SchemaCompatibilityError, match="4: expected 0004_movement_blocks, found 0004_different_branch"):
        assert_compatible_migrations(conflicting)


def test_forward_repair_preserves_recorded_movement_version():
    migrations = expected_migrations()
    assert migrations[4] == "0004_movement_blocks"
    assert migrations[5] == "0005_restore_terrain_coordinates"
    repair = (MIGRATIONS_DIR / f"{migrations[5]}.sql").read_text()
    assert "DROP COLUMN coordinate_version" in repair
    assert "CREATE TABLE IF NOT EXISTS schema_contract" in repair
    assert "ON CONFLICT (key) DO UPDATE" in repair
    assert "x < 256" in repair and "y < 256" in repair


def test_finalized_movement_blocks_use_a_forward_only_coordinate_transition():
    migrations = expected_migrations()
    assert migrations[6] == "0006_enable_movement_blocks"
    transition = (MIGRATIONS_DIR / f"{migrations[6]}.sql").read_text()
    assert "DELETE FROM player_positions" in transition
    assert "x < 32" in transition and "y < 32" in transition
    assert "VALUES ('coordinate_version', 2)" in transition


def test_combat_records_start_at_zero_without_backfilling_history():
    migrations = expected_migrations()
    assert migrations[10] == "0010_combat_records"
    migration = (MIGRATIONS_DIR / f"{migrations[10]}.sql").read_text()
    assert "DEFAULT 0" in migration
    assert "SELECT id FROM players" in migration
    assert "world_events" not in migration and "world_commands" not in migration


def test_coordinate_version_must_match_shared_layout():
    class Connection:
        def __init__(self, version):
            self.version = version

        async def fetchval(self, query):
            del query
            return self.version

    asyncio.run(assert_coordinate_contract(Connection(5)))
    with pytest.raises(SchemaCompatibilityError, match="expected version 5, found 1"):
        asyncio.run(assert_coordinate_contract(Connection(1)))


def test_movement_block_migration_discards_legacy_positions_and_constrains_coordinates():
    migration = (MIGRATIONS_DIR / "0004_movement_blocks.sql").read_text(encoding="utf-8")
    assert "DELETE FROM player_positions" in migration
    assert "coordinate_version" in migration
    assert "x < 32" in migration
    assert "y < 32" in migration


def test_database_config_from_parts_and_url():
    assert DatabaseConfig.from_env({}) is None
    cfg = DatabaseConfig.from_env(
        {"DB_HOST": "db.example", "DB_PORT": "5433", "DB_DATABASE": "postgres", "DB_USER": "U@x", "DB_PASSWORD": "p:w"}
    )
    assert cfg.dsn == "postgresql://u%40x:p%3Aw@db.example:5433/postgres?sslmode=require"
    assert cfg.schema == "party_conquest"
    assert "p:w" not in repr(cfg)
    url = DatabaseConfig.from_env({"DATABASE_URL": "postgresql://a:b@h/d", "DB_SCHEMA": "sandbox"})
    assert url == DatabaseConfig(dsn="postgresql://a:b@h/d", schema="sandbox")
    with pytest.raises(ValueError):
        DatabaseConfig.from_env({"DATABASE_URL": "x", "DB_SCHEMA": "Bad-Name"})


def test_expanded_map_migration_preserves_positions_and_expands_bounds():
    migration = (MIGRATIONS_DIR / '0007_expand_map.sql').read_text()
    assert 'DELETE FROM' not in migration
    assert 'x < 40' in migration and 'y < 40' in migration
    assert "value=3 WHERE key='coordinate_version'" in migration


def test_quadruple_map_migration_translates_live_state_and_widens_bounds_atomically():
    migration = (MIGRATIONS_DIR / '0015_quadruple_map.sql').read_text()
    assert 'DELETE FROM' not in migration
    assert 'UPDATE player_positions SET x = x + 40, y = y + 40' in migration
    assert 'UPDATE gold_drops SET x = x + 40, y = y + 40' in migration
    assert 'UPDATE world_powerup_cycles SET chest_x = chest_x + 40, chest_y = chest_y + 40' in migration
    assert "WHERE state = 'chest'" in migration
    assert 'UPDATE world_events' not in migration
    assert 'UPDATE world_commands' not in migration
    assert migration.index('DROP CONSTRAINT player_positions_x_check') < migration.index('UPDATE player_positions')
    assert migration.index('UPDATE player_positions') < migration.index('x < 80')
    assert 'x < 80' in migration and 'y < 80' in migration
    assert "value=4 WHERE key='coordinate_version'" in migration


def test_world_doors_table_defaults_open_and_is_world_scoped():
    migration = (MIGRATIONS_DIR / "0019_world_doors.sql").read_text()
    assert "CREATE TABLE world_doors" in migration
    assert "open boolean NOT NULL DEFAULT TRUE" in migration
    assert "REFERENCES world_streams(world_id)" in migration


def test_combat_record_migration_has_once_per_life_spread_state():
    migration = (MIGRATIONS_DIR / '0011_spread_reward.sql').read_text()
    assert 'ALTER TABLE combat_records' in migration
    assert 'CREATE TABLE' not in migration
    assert 'spread_earned' in migration
    assert 'spread_expires_at' in migration
    assert 'UPDATE combat_records' not in migration


def test_treasure_hunt_migration_adds_private_per_player_routes_without_touching_shared_state():
    migrations = expected_migrations()
    assert migrations[20] == '0020_treasure_hunts'
    migration = (MIGRATIONS_DIR / '0020_treasure_hunts.sql').read_text()
    assert 'CREATE TABLE player_treasure_hunts' in migration
    assert 'PRIMARY KEY (world_id, player_id)' in migration
    assert 'stage >= 0 AND stage <= 2' in migration
    assert 'previous_route text[]' in migration
    assert 'DELETE FROM' not in migration and 'UPDATE ' not in migration
    assert 'player_progression' not in migration


def test_heavy_grenade_migration_adds_capped_inventory_and_pickups():
    migrations = expected_migrations()
    assert migrations[24] == '0024_heavy_grenades'
    migration = (MIGRATIONS_DIR / '0024_heavy_grenades.sql').read_text()
    assert 'ADD COLUMN heavy_grenades integer NOT NULL DEFAULT 0' in migration
    assert 'CHECK (heavy_grenades >= 0 AND heavy_grenades <= 3)' in migration
    assert 'CREATE TABLE heavy_grenade_drops' in migration
    assert 'DELETE FROM' not in migration and 'UPDATE ' not in migration


def test_cube_migration_widens_every_coordinate_without_translating_state():
    migrations = expected_migrations()
    assert migrations[26] == '0026_cube_world'
    migration = (MIGRATIONS_DIR / '0026_cube_world.sql').read_text()
    assert 'DELETE FROM' not in migration and 'SET x' not in migration
    for table in ('player_positions', 'gold_drops', 'world_mobs', 'world_webs', 'heavy_grenade_drops'):
        assert f'DROP CONSTRAINT {table}_x_check' in migration
        assert f'ADD CONSTRAINT {table}_x_check CHECK (x >= 0 AND x < 485)' in migration
    assert "value=5 WHERE key='coordinate_version'" in migration


def test_october_baseline_restore_keeps_history_and_normalizes_gameplay():
    """0033-0037 stay byte-compatible; 0038 only moves stranded rows forward."""
    migrations = expected_migrations()
    assert migrations[33] == '0033_expanded_world'
    assert migrations[34] == '0034_mob_spawn_health'
    assert migrations[35] == '0035_space_world'
    assert migrations[36] == '0036_orbital_gravity'
    assert migrations[37] == '0037_ghosts'
    assert migrations[38] == '0038_restore_october_baseline'
    earlier = (MIGRATIONS_DIR / '0033_expanded_world.sql').read_text()
    assert "value=6 WHERE key='coordinate_version'" in earlier
    assert 'DROP TABLE' not in earlier
    restore = (MIGRATIONS_DIR / '0038_restore_october_baseline.sql').read_text()
    assert 'DROP TABLE' not in restore
    assert 'DELETE FROM players' not in restore
    assert 'INSERT INTO player_positions' not in restore
    assert 'DELETE FROM world_mobs' in restore
    assert "kind IN ('basic', 'ranged')" in restore
    assert 'LEAST(health, 3)' in restore
    assert 'phase_until = NULL' in restore
    assert 'x >= 80' in restore
    assert 'y < 80' in restore
    assert "value = 5 WHERE key = 'coordinate_version'" in restore
    assert 'player_space_states' not in restore
