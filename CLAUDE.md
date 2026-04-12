# Racer

3D couch party racer. Up to 4 players use their phones as controllers; a
shared display renders the race with split-screen viewports. Architecture
mirrors the existing Tetris/couch-games project (`/Users/tim/Projects/Tetris`)
and uses the Party-Sockets relay (`/Users/tim/Projects/Party-Sockets`) as its
WebSocket transport.

## Stack

- **TypeScript + Vite** (multi-entry: display + controller)
- **Three.js** for rendering
- **Rapier 3D** (`@dimforge/rapier3d-compat`) for physics + raycast vehicle
- **Bun** for the HTTP server
- **bun test** for unit tests, **Playwright** for e2e

## Commands

```sh
bun install                  # install deps
bun run dev                  # Bun server (proxies to Vite for HMR) on :4000
bun run build                # production Vite build into dist/
bun run start                # production server (serves dist/)
bun test                     # unit tests
bunx playwright test         # e2e tests (start a server on :4001)
```

Open `http://localhost:4000/` for the display. Phones join via the QR code,
which encodes the LAN URL `http://<lan-ip>:4000/<ROOM>`.

## Debug mode

Append `?debug=1` to the display URL to:
- Skip the welcome screen
- Allow keyboard input on the first car (←/→ steer, ↓ brake)
- Allow starting the race with zero phones connected

## Conventions

- **Display is authoritative.** All physics and game logic live there;
  controllers only stream `INPUT` messages.
- **Wire protocol** lives in `src/shared/protocol.ts`. Don't introduce ad-hoc
  message shapes — extend the namespace.
- **Hand-coded primitives only.** No imported 3D models. Boxes, cylinders,
  planes; tune materials with vertex colors or flat MeshLambertMaterials.
- **Race loop** is fixed-step (1/60 s) inside `RaceSim.tick()`. Don't put
  sim logic in render-frame callbacks.

## File map

```
server/index.ts              Bun HTTP server (static + API + Vite proxy in dev)
src/shared/protocol.ts       Message namespace, types, RELAY_URL
src/shared/PartyConnection.ts WebSocket relay client (TS port from Tetris)

src/display/main.ts          Display entry — wires welcome → DisplayGame.start()
src/display/DisplayGame.ts   State machine (lobby → countdown → racing → finished)
src/display/DisplayConnection.ts Party-Sockets, room creation, QR, peer lifecycle
src/display/DisplayState.ts  Shared mutable state container
src/display/RaceSim.ts       Rapier world + cars + fixed-step loop
src/display/Car.ts           Raycast-vehicle wrapper + Three mesh
src/display/AiDriver.ts      Waypoint follower for AI seats
src/display/Track.ts         Hand-coded oval, walls, checkpoints, spawn grid
src/display/SplitScreen.ts   Viewport layout algorithm + per-car cameras
src/display/Hud.ts           Per-viewport DOM HUD overlay
src/display/Audio.ts         Web Audio engine loop + SFX
src/display/KeyboardDebug.ts Dev-only keyboard input

src/controller/main.ts          Controller entry — name screen + dispatch
src/controller/ControllerGame.ts State machine (name → lobby → game → finished)
src/controller/ControllerConnection.ts Party-Sockets, ping/pong, input streaming
src/controller/TouchInput.ts     Pointer drag → continuous {steer, brake}
src/controller/Hud.ts            Game-screen HUD

tests/*.test.ts              Unit tests (bun test)
tests/e2e/*.spec.ts          Playwright lobby + race specs
```

## Editing guidelines

- Don't reach into Tetris files; copy patterns by reading them, then write
  the TS equivalent here.
- Keep `Track`, `Car`, `SplitScreen`, `TouchInput`, and `protocol` test-friendly:
  pure functions and structured constructors with no module-level state.
- Don't add features beyond the plan unless asked. The plan lives at
  `/Users/tim/.claude/plans/resilient-cuddling-eagle.md`.
