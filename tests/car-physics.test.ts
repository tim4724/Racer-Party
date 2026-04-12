// Integration test: load Rapier, build a minimal world with a flat ground
// and a single Car, apply default input ({steer:0, brake:0} → auto-throttle),
// step the world, and verify the car actually moves forward.
//
// This is the test that catches the "cars don't move" bug. It uses the real
// Rapier WASM via @dimforge/rapier3d-compat (sync-init flavor) — no DOM.

import { describe, expect, test, beforeAll } from 'bun:test';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Car } from '@display/Car';

beforeAll(async () => {
  await RAPIER.init();
});

function makeWorldWithGround(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: -9.81 * 2, z: 0 });
  const groundDesc = RAPIER.ColliderDesc.cuboid(200, 0.1, 200)
    .setTranslation(0, -0.1, 0)
    .setFriction(1.5);
  world.createCollider(groundDesc);
  return world;
}

function spawnCar(
  world: RAPIER.World,
  forward: THREE.Vector3,
  height = 1.5,
): Car {
  const car = new Car({
    carId: 0,
    name: 'Test',
    color: '#fff',
    isAI: false,
    spawn: { position: new THREE.Vector3(0, height, 0), forward },
  });
  car.buildPhysics(world, RAPIER, {
    position: new THREE.Vector3(0, height, 0),
    forward,
  });
  return car;
}

function stepN(world: RAPIER.World, car: Car, n: number, dt = 1 / 60): void {
  for (let i = 0; i < n; i++) {
    car.step(dt);
    world.step();
  }
}

describe('Car physics — forward motion', () => {
  test('default input (auto-throttle) accelerates the car forward (+Z spawn)', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 120); // 2 seconds

    const t = car.body.translation();
    const v = car.body.linvel();

    // Should have moved forward in +Z and have +Z velocity.
    expect(t.z).toBeGreaterThan(1.0);
    expect(v.z).toBeGreaterThan(1.0);
    // And shouldn't have drifted sideways or sunk through the ground.
    expect(Math.abs(t.x)).toBeLessThan(2);
    expect(t.y).toBeGreaterThan(-0.1);
  });

  test('default input accelerates the car forward when spawned facing +X', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(1, 0, 0));
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 120);

    const t = car.body.translation();
    const v = car.body.linvel();

    // Should have moved in +X (its forward) and have +X velocity.
    expect(t.x).toBeGreaterThan(1.0);
    expect(v.x).toBeGreaterThan(1.0);
    expect(Math.abs(t.z)).toBeLessThan(2);
  });

  test('full brake from rest reverses the car (brake → reverse fallthrough)', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));
    car.applyInput({ steer: 0, brake: 1 });
    stepN(world, car, 120);

    const t = car.body.translation();
    const v = car.body.linvel();
    // Should now be moving backward (negative z, since car faces +z).
    expect(v.z).toBeLessThan(-1);
    expect(t.z).toBeLessThan(-0.5);
  });

  test('car settles on the ground (does not fall through or hover)', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));
    car.applyInput({ steer: 0, brake: 1 }); // hold still
    stepN(world, car, 120);

    const t = car.body.translation();
    // Chassis center should be roughly between 0.5m and 2m above ground.
    expect(t.y).toBeGreaterThan(0.4);
    expect(t.y).toBeLessThan(2.0);
  });

  // Regression test for the "stuck brake after countdown" bug.
  // Simulates the actual game flow:
  //   1. Countdown sets {brake:1} every tick (cars frozen)
  //   2. Race starts
  //   3. Human car's input is whatever was last set — until the controller
  //      sends a fresh INPUT message. If we don't reset on race start, the
  //      car stays braked forever.
  test('car accelerates after brake is released following a countdown freeze', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));

    // Countdown: 3s of brake.
    car.applyInput({ steer: 0, brake: 1 });
    stepN(world, car, 180);
    const zAfterFreeze = car.body.translation().z;

    // Race start: clear input (this is what RaceSim.startRace must do).
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 180); // 3s of racing

    const tAfter = car.body.translation();
    const vAfter = car.body.linvel();
    expect(tAfter.z - zAfterFreeze).toBeGreaterThan(2);
    expect(vAfter.z).toBeGreaterThan(2);
  });

  test('acceleration is brisk: car reaches > 15 m/s after 2s of auto-throttle', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 120);
    const v = car.body.linvel();
    expect(v.z).toBeGreaterThan(15);
  });

  test('small brake input is ignored while steering (no decel)', () => {
    // Brake input is zeroed out while steering (steeringActive), so a small
    // brake while turning carries the same speed as a no-brake turn.
    const w1 = makeWorldWithGround();
    const c1 = spawnCar(w1, new THREE.Vector3(0, 0, 1));
    c1.applyInput({ steer: 0, brake: 0 });
    stepN(w1, c1, 120);
    c1.applyInput({ steer: 1, brake: 0 });
    stepN(w1, c1, 30);
    const noBrakeSpeed = Math.hypot(c1.body.linvel().x, c1.body.linvel().z);

    const w2 = makeWorldWithGround();
    const c2 = spawnCar(w2, new THREE.Vector3(0, 0, 1));
    c2.applyInput({ steer: 0, brake: 0 });
    stepN(w2, c2, 120);
    c2.applyInput({ steer: 1, brake: 0.3 });
    stepN(w2, c2, 30);
    const smallBrakeSpeed = Math.hypot(c2.body.linvel().x, c2.body.linvel().z);

    // Should be (almost) identical — small brake is ignored mid-turn.
    expect(Math.abs(smallBrakeSpeed - noBrakeSpeed)).toBeLessThan(1);
  });

  test('hard steering reduces throttle (arcade lift assist)', () => {
    // Straight-line accel baseline.
    const w1 = makeWorldWithGround();
    const c1 = spawnCar(w1, new THREE.Vector3(0, 0, 1));
    c1.applyInput({ steer: 0, brake: 0 });
    stepN(w1, c1, 120);
    const straightSpeed = Math.hypot(c1.body.linvel().x, c1.body.linvel().z);

    // Same time, full steer lock.
    const w2 = makeWorldWithGround();
    const c2 = spawnCar(w2, new THREE.Vector3(0, 0, 1));
    c2.applyInput({ steer: 1, brake: 0 });
    stepN(w2, c2, 120);
    const steeredSpeed = Math.hypot(c2.body.linvel().x, c2.body.linvel().z);

    // The steering car should be noticeably slower (engine output is reduced).
    expect(steeredSpeed).toBeLessThan(straightSpeed - 1);
  });

  test('top speed reaches > 35 m/s after a long straight', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));
    car.applyInput({ steer: 0, brake: 0 });
    // 6s of acceleration on flat ground.
    stepN(world, car, 360);
    const v = car.body.linvel();
    const speed = Math.hypot(v.x, v.z);
    expect(speed).toBeGreaterThan(35);
  });

  // Brake-then-reverse: holding the brake while stopped should drive the car
  // backward instead of just sitting still. This is what the player gets when
  // they hold a downward drag against a wall.
  test('holding brake against a wall reverses the car', () => {
    const world = makeWorldWithGround();
    // Wall directly in front of the car at z = 8
    const wallDesc = RAPIER.ColliderDesc.cuboid(20, 5, 0.5)
      .setTranslation(0, 2, 8)
      .setFriction(0.4);
    world.createCollider(wallDesc);

    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));
    // Drive forward into the wall.
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 180);
    const tAtWall = car.body.translation();
    expect(tAtWall.z).toBeGreaterThan(2); // got close to wall
    expect(tAtWall.z).toBeLessThan(8);    // didn't pass through

    // Now hold the brake — should reverse out.
    car.applyInput({ steer: 0, brake: 1 });
    stepN(world, car, 180); // 3s
    const tAfterReverse = car.body.translation();
    const vAfterReverse = car.body.linvel();
    expect(tAfterReverse.z).toBeLessThan(tAtWall.z - 1.5);
    expect(vAfterReverse.z).toBeLessThan(-0.5);
  });

  // Steering convention: positive steer = right (toward the chase cam's
  // right), negative = left. We assert in car-relative terms instead of
  // world coordinates: "right of forward" is `forward × up` in a
  // right-handed coord system, NOT `up × forward`.
  //
  // We project the displacement onto that right vector — a positive
  // projection means the car curved right relative to its initial heading.
  function rightOfForward(forward: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  }

  function steeringDrift(forward: THREE.Vector3, steerInput: number): number {
    const world = makeWorldWithGround();
    const car = spawnCar(world, forward);
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 60); // 1s warmup
    const start = car.body.translation();
    const startVec = new THREE.Vector3(start.x, 0, start.z);
    car.applyInput({ steer: steerInput, brake: 0 });
    stepN(world, car, 90); // 1.5s steering
    const end = car.body.translation();
    const endVec = new THREE.Vector3(end.x, 0, end.z);
    const delta = endVec.sub(startVec);
    return delta.dot(rightOfForward(forward));
  }

  test('positive steer turns the car right (chase-cam relative)', () => {
    expect(steeringDrift(new THREE.Vector3(0, 0, 1), 1)).toBeGreaterThan(2);
    expect(steeringDrift(new THREE.Vector3(1, 0, 0), 1)).toBeGreaterThan(2);
  });

  test('negative steer turns the car left (chase-cam relative)', () => {
    expect(steeringDrift(new THREE.Vector3(0, 0, 1), -1)).toBeLessThan(-2);
    expect(steeringDrift(new THREE.Vector3(1, 0, 0), -1)).toBeLessThan(-2);
  });

  // Regression: holds steer + brake from a stopped position and asserts the
  // car actually moves backward.
  test('reverse engages even when steering is also held', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));
    // Start braking from rest (no warmup).
    car.applyInput({ steer: 1, brake: 1 });
    stepN(world, car, 90); // 1.5s
    const v = car.body.linvel();
    // Reverse means forward velocity is negative (along the original +Z spawn).
    // After steering, the heading has rotated; we just check the car moved
    // away from origin and is not stuck.
    const t = car.body.translation();
    const dist = Math.hypot(t.x, t.z);
    expect(dist).toBeGreaterThan(0.5);
    // And it should NOT be moving forward in its current heading.
    const fwd = car.forward().setY(0).normalize();
    const fwdSpeed = fwd.x * v.x + fwd.z * v.z;
    expect(fwdSpeed).toBeLessThan(0); // moving backward relative to its facing
  });

  test('steering still works while reversing (brake held + steer right)', () => {
    // No-steer reverse baseline (90 ticks = 1.5s — long enough to be reversing
    // but short enough that the car doesn't pivot 180° at full lock).
    const w1 = makeWorldWithGround();
    const c1 = spawnCar(w1, new THREE.Vector3(0, 0, 1));
    c1.applyInput({ steer: 0, brake: 1 });
    stepN(w1, c1, 90);
    const baseline = c1.body.translation();
    expect(c1.body.linvel().z).toBeLessThan(-0.5);

    // Steer-right reverse.
    const w2 = makeWorldWithGround();
    const c2 = spawnCar(w2, new THREE.Vector3(0, 0, 1));
    c2.applyInput({ steer: 1, brake: 1 });
    stepN(w2, c2, 90);
    const t = c2.body.translation();

    // The two trajectories must diverge — proves steering has an effect.
    expect(Math.hypot(t.x - baseline.x, t.z - baseline.z)).toBeGreaterThan(0.3);
  });

  test('AI respawns its car when stuck for 2+ seconds', async () => {
    const { Track } = await import('@display/Track');
    const { AiDriver } = await import('@display/AiDriver');
    const world = makeWorldWithGround();
    const track = new Track();

    // Spawn the car FAR from any centerline waypoint and never step the
    // physics — car.speed stays 0 the whole time, simulating "wedged
    // against a wall". After ~2s of stuck time the AI should teleport it.
    const spawn = {
      position: new THREE.Vector3(180, 1.5, 180),
      forward: new THREE.Vector3(1, 0, 0),
    };
    const car = new Car({
      carId: 0,
      name: 'CPU',
      color: '#fff',
      isAI: true,
      spawn,
    });
    car.buildPhysics(world, RAPIER, spawn);
    const ai = new AiDriver(car, track);

    const startX = car.body.translation().x;
    const startZ = car.body.translation().z;

    // car.speed defaults to 0 (set in step()) — simulate the AI being
    // called once per fixed step for ~2.5s.
    for (let i = 0; i < 150; i++) {
      ai.computeInput();
    }

    const t = car.body.translation();
    const moved = Math.hypot(t.x - startX, t.z - startZ);
    // Should have teleported far from the wedged position toward a
    // centerline waypoint (the closest waypoint to (180,180) is on the loop,
    // which has bounding box ±70 — at least ~100 units away).
    expect(moved).toBeGreaterThan(50);
  });

  test('upside-down car auto-recovers after ~1.5 seconds', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 30);

    // Manually flip the chassis 180° around its forward axis (roll over).
    car.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true); // 180° around Z
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    // Confirm we're actually upside down.
    const r0 = car.body.rotation();
    const upY0 = 1 - 2 * (r0.x * r0.x + r0.z * r0.z);
    expect(upY0).toBeLessThan(0); // pointing down

    // 1.5s + a couple frames should trigger recovery.
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 95);

    const r1 = car.body.rotation();
    const upY1 = 1 - 2 * (r1.x * r1.x + r1.z * r1.z);
    expect(upY1).toBeGreaterThan(0.9); // upright again
  });

  // Hard brake from speed must not flip the car (forward pitch-over) — used
  // to happen with brake force 60 + low angular damping. Catches regressions
  // in the brake force / angular damping / center-of-mass tuning.
  test('hard brake from speed does not flip the car', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));

    // Get up to speed.
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 180); // 3s
    expect(car.body.linvel().z).toBeGreaterThan(5);

    // Slam on the brakes.
    car.applyInput({ steer: 0, brake: 1 });
    stepN(world, car, 60); // 1s

    // Chassis local up should still point roughly toward world +Y.
    const r = car.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    // Allow up to ~25° of pitch/roll, but no flipping.
    expect(localUp.y).toBeGreaterThan(0.9);
  });

  // Progressive brake: small brake input should decelerate the car gently.
  // Used to slam throttle to zero on any brake > 5%, which felt like an
  // emergency stop even from a brief keyboard tap.
  test('small brake input only mildly slows the car (does not slam throttle off)', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));

    // Get up to speed.
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 120);
    const vBefore = car.body.linvel().z;
    expect(vBefore).toBeGreaterThan(5);

    // Apply a SMALL brake input for 1 second.
    car.applyInput({ steer: 0, brake: 0.2 });
    stepN(world, car, 60);
    const vAfter = car.body.linvel().z;

    // Car should still be moving forward at meaningful speed (not stopped).
    expect(vAfter).toBeGreaterThan(2);
  });

  test('small brake input decelerates less than full brake input', () => {
    // Light brake.
    const w1 = makeWorldWithGround();
    const c1 = spawnCar(w1, new THREE.Vector3(0, 0, 1));
    c1.applyInput({ steer: 0, brake: 0 });
    stepN(w1, c1, 120);
    c1.applyInput({ steer: 0, brake: 0.2 });
    stepN(w1, c1, 60);
    const lightSpeed = c1.body.linvel().z;

    // Hard brake.
    const w2 = makeWorldWithGround();
    const c2 = spawnCar(w2, new THREE.Vector3(0, 0, 1));
    c2.applyInput({ steer: 0, brake: 0 });
    stepN(w2, c2, 120);
    c2.applyInput({ steer: 0, brake: 1 });
    stepN(w2, c2, 60);
    const hardSpeed = c2.body.linvel().z;

    // Light brake car should still be going faster than the hard-brake car.
    expect(lightSpeed).toBeGreaterThan(hardSpeed + 1);
  });

  test('holding brake while moving forward decelerates the car (no reverse mid-flight)', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world, new THREE.Vector3(0, 0, 1));

    // Get up to speed.
    car.applyInput({ steer: 0, brake: 0 });
    stepN(world, car, 120);
    const vBefore = car.body.linvel().z;
    expect(vBefore).toBeGreaterThan(5);

    // Apply brake. The car should decelerate, not immediately reverse.
    car.applyInput({ steer: 0, brake: 1 });
    // After 0.25s of braking, still moving forward (not yet reversing).
    stepN(world, car, 15);
    const vMid = car.body.linvel().z;
    expect(vMid).toBeLessThan(vBefore);
    expect(vMid).toBeGreaterThan(0);
  });
});
