# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                    # install deps
bun run dev                    # dev server on :4000 (Bun + Vite HMR)
bun test                       # unit tests
bunx playwright test           # e2e tests (server on :4001)
```

Debug mode: append `?debug=1` to display URL (keyboard input, skip welcome, zero-phone start).

## Key Rules

- Display is authoritative — all physics/game logic there; controllers only stream INPUT messages
- Wire protocol lives in `src/shared/protocol.ts` — extend the namespace, no ad-hoc messages
- Hand-coded primitives only — no imported 3D models
- Race loop is fixed-step (1/60 s) in `RaceSim.tick()` — no sim logic in render callbacks
- Keep `Track`, `Car`, `SplitScreen`, `TouchInput`, `protocol` test-friendly: pure functions, structured constructors, no module-level state
- Relay URL configured in `src/shared/protocol.ts`
