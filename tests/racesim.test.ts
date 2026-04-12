// Headless RaceSim integration test. Catches bugs that span multiple modules
// — specifically the "human cars stay braked after countdown ends" regression.
//
// Constructs RaceSim with `canvas: null` to skip the WebGL renderer (which
// can't run in Bun's Node-like test environment), then drives the sim
// manually with `tickOnce()`.

import { describe, expect, test, beforeAll } from 'bun:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { RaceSim } from '@display/RaceSim';
import type { Player } from '@display/DisplayConnection';

beforeAll(async () => {
  await RAPIER.init();
});

function makeSim(humans: Player[], aiCount: number): RaceSim {
  return new RaceSim({
    canvas: null,
    humans,
    aiCount,
    totalLaps: 3,
    onLapCompleted: () => {},
    onRaceFinished: () => {},
  });
}

const humanPlayer: Player = { id: 'phone-1', name: 'Alice', color: '#ff7a18', carId: 0 };

describe('RaceSim — race start', () => {
  test('cars stay in place during the countdown freeze (do not reverse)', async () => {
    const sim = makeSim([humanPlayer], 3);
    await sim.init();

    const startPos = { ...sim.cars[0].body.translation() };

    // 2 seconds of countdown — should not move anywhere meaningful.
    for (let i = 0; i < 120; i++) sim.tickOnce();

    const t = sim.cars[0].body.translation();
    const drift = Math.hypot(t.x - startPos.x, t.z - startPos.z);
    expect(drift).toBeLessThan(0.5);
  });

  test('human car has zero brake input after startRace()', async () => {
    const sim = makeSim([humanPlayer], 3);
    await sim.init();

    // Simulate countdown — RaceSim freezes cars internally.
    for (let i = 0; i < 30; i++) sim.tickOnce();

    sim.startRace();
    // After race start, car input is cleared so auto-throttle takes over.
    expect(sim.cars[0].input.brake).toBe(0);
    expect(sim.cars[0].input.steer).toBe(0);
  });

  test('human car accelerates after race start even if no INPUT message arrives', async () => {
    const sim = makeSim([humanPlayer], 3);
    await sim.init();

    // 1 second of countdown freeze.
    for (let i = 0; i < 60; i++) sim.tickOnce();
    const startZ = sim.cars[0].body.translation().z;
    const startX = sim.cars[0].body.translation().x;

    sim.startRace();

    // 2 seconds of racing — phone never sends an INPUT.
    for (let i = 0; i < 120; i++) sim.tickOnce();

    const t = sim.cars[0].body.translation();
    const v = sim.cars[0].body.linvel();
    const moved = Math.hypot(t.x - startX, t.z - startZ);
    const speed = Math.hypot(v.x, v.z);

    expect(moved).toBeGreaterThan(2);
    expect(speed).toBeGreaterThan(2);
  });

  test('AI cars also accelerate after race start', async () => {
    const sim = makeSim([], 4); // all AI
    await sim.init();
    for (let i = 0; i < 30; i++) sim.tickOnce();
    sim.startRace();
    for (let i = 0; i < 180; i++) sim.tickOnce();

    for (const car of sim.cars) {
      const v = car.body.linvel();
      const speed = Math.hypot(v.x, v.z);
      // Each AI should have moved at least a little.
      expect(speed).toBeGreaterThan(0.5);
    }
  });
});
