# Party Conquest

## What it is

Party Conquest is a real-time, browser-based arena game on one shared pixel
world. Every player is an archer roaming the same 80 × 80 map at the same time,
battling other players and roaming mobs.

There are no matches, rounds, or winners, and the world never resets. You can
join at any time. When you fall, you rejoin straight away with the same account
and avatar.

New players see a single-screen **How to play** panel on their first visit on
each device. It explains the objective and the controls for that device, and
the **How to play** button in the control dock reopens it at any time.

## Core loop

1. Sign in with a name, a 4-digit PIN, and any of the 32 avatars (all free),
   then drop into the world.
2. Explore: roads, bridges, forests, and walled courtyards shape where you can
   walk and where arrows can fly.
3. Fight players and mobs with your bow.
4. If you're defeated, rejoin and keep going.

## Movement and the map

- Movement is smooth and continuous at one standard speed: north, south, east,
  or west. Hold a direction to keep moving. Water, trees, walls, and barricades
  block movement; bridges cross water.
- The camera follows your player. You can pan and zoom freely, jump back to
  **My player**, or **Fit world** to see the whole map. Clean view hides the
  informational chrome, and fullscreen is one button away.

## Combat

- **Arrows:** Space (or FIRE on touch) shoots an arrow up to 4 squares the way
  you're facing. Trees, walls, and water stop it. The first player or mob in
  its path is hit.
- One arrow defeats a player.
- Mobs take three arrows. Up to four of them roam the world while players are
  in it. They're all the same, they hunt nearby players, and defeating one
  gives no reward.

## Being defeated

A defeated player can't move or fire. The defeated screen offers **Rejoin
world** (or press Space), and you respawn quickly with the same identity and
avatar.

## Devices

- **Desktop:** WASD or the arrow keys to move, Space to shoot and to rejoin.
  Scroll to pan, ⌘/Ctrl + scroll to zoom, and middle-drag to pan.
- **Touch:** phones and tablets get an on-screen pad. Hold the arrows to move,
  tap FIRE to shoot, drag to pan, and pinch to zoom. Change avatar is in the
  Player actions button next to the pad.
- The game has no sound.

## Shared world rules

- The server is authoritative for positions and combat. Clients render the
  shared state and send commands.
- Everyone sees the same world live. Reconnecting catches you up to the
  current state.
- The world is persistent: there is no scheduled reset, and it keeps changing
  while you're away.
