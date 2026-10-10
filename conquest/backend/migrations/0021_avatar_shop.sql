-- Permanent, account-level ownership of shop-exclusive avatars. A row exists
-- only for paid avatars; the twelve launch avatars stay free for everyone.
-- Ownership never depends on world membership, gold, or a life, so death and
-- gold drops leave this table untouched.
CREATE TABLE player_avatar_unlocks (
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  avatar text NOT NULL,
  price bigint NOT NULL CHECK (price >= 0),
  purchased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, avatar)
);
