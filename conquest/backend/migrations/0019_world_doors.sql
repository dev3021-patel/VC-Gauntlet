CREATE TABLE world_doors (
  world_id text NOT NULL REFERENCES world_streams(world_id) ON DELETE CASCADE,
  door_id text NOT NULL,
  open boolean NOT NULL DEFAULT TRUE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, door_id)
);
