# Player stealth: retired (Issue #110)

Stealth (Issue #104) was removed to simplify play. Every connected living
player is a normal target for melee and ranged mobs.

- Removed: `backend/app/stealth.py`, the `player.stealth` action (now
  `unsupported_action` over HTTP and the socket), pace tracking on moves,
  per-mob detection in `plan_tick`, the `mob.tick` `stealth` list,
  `stealth`/`stealthDetected` on public positions, `stealthBroken` on shots,
  the C key, the **Stealth** Player actions button, the Hidden/Detected badge
  and faded avatar, and the How to play stealth note (`HOW_TO_PLAY_VERSION` 4).
- Migration `0032_player_stealth` stays applied. Its `stealth`,
  `stealth_detected`, `pace`, and `pace_at` columns remain on
  `player_positions` but nothing reads or writes them, so a row stored while
  stealthed is targeted normally. They were kept, not dropped, so old pods
  still reading them survive a rolling deploy. A later migration may drop them.
- Old `player.stealth_changed` events in replay are ignored by clients, since
  they are no longer in `POSITION_EVENTS`.
- Coverage: `backend/tests/test_hitboxes.py`
  (`test_retired_stealth_state_never_hides_a_player_or_reaches_clients`), the
  retired-action list in `test_player_positions.py`, and the
  `retired stealth (Issue #110)` block in `MapCanvas.test.tsx`.
