-- One replaceable, account-private uploaded avatar per player. avatar_id is the
-- value stored in players.avatar while it is equipped; a replacement mints a
-- new ID so cached images never outlive the upload they belong to.
CREATE TABLE player_custom_avatars (
  player_id uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  avatar_id text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  image bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 2097152),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Built-in avatars held in a world. The primary key makes a claim atomic across
-- replicas; a claim only counts while its holder has a fresh
-- player_world_connections lease, and is released when the last one closes.
CREATE TABLE world_avatar_claims (
  world_id text NOT NULL,
  avatar text NOT NULL,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, avatar)
);

CREATE INDEX world_avatar_claims_player ON world_avatar_claims(world_id, player_id);
