"""Attack-independent elimination consumer, run inside the world transaction."""

import uuid


async def resolve_eliminations(connection, world_id: str, payload: dict) -> None:
    """Consume resolver-authored combatElimination (never raw command input).

    Resolvers supply attackerId and a victims list of public positions, and must
    leave removal to this consumer. A revision-guarded delete claims each life,
    so repeated victims, self hits, and already-removed lives are ignored. A
    null attackerId (an enemy mob) may eliminate any listed player. The
    transport's command deduplication and transaction cover replay/rollback.
    """
    elimination = payload.pop("combatElimination", None)
    if elimination is None:
        return
    attacker = uuid.UUID(elimination["attackerId"]) if elimination.get("attackerId") else None
    confirmed = []
    seen = set() if attacker is None else {attacker}
    for victim in elimination["victims"]:
        victim_id = uuid.UUID(victim["playerId"])
        if victim_id in seen:
            continue
        seen.add(victim_id)
        removed = await connection.fetchval(
            """DELETE FROM player_positions
               WHERE world_id=$1 AND player_id=$2 AND revision=$3
               RETURNING player_id""",
            world_id, victim_id, victim["positionRevision"],
        )
        if removed is not None:
            confirmed.append(victim)
    payload["eliminatedVictims"] = confirmed


# Read both the shared confirmed-life contract and historical single-arrow events.
VICTIM_DEATHS_QUERY = """
    SELECT DISTINCT ON (victim->>'playerId') victim->>'playerId' player_id,
           (outcome->'event'->>'revision')::bigint revision,
           COALESCE(outcome->'event'->'payload'->>'shooterName',
                    outcome->'event'->'payload'->>'throwerName',
                    outcome->'event'->'payload'->>'attackerName') attacker_name
    FROM world_commands
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(
        outcome->'event'->'payload'->'eliminatedVictims',
        CASE WHEN jsonb_typeof(outcome->'event'->'payload'->'victims')='array'
             THEN outcome->'event'->'payload'->'victims'
             WHEN jsonb_typeof(outcome->'event'->'payload'->'victim')='object'
             THEN jsonb_build_array(outcome->'event'->'payload'->'victim')
             ELSE '[]'::jsonb END
    )) victim
    WHERE world_id=$1 AND victim->>'playerId' IS NOT NULL
    ORDER BY 1, revision DESC
"""
