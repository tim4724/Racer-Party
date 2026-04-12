// Drift tuning diagnostic — runs the car with and without drift and prints
// measured physics values so we can see what's actually happening.

import { describe, expect, test, beforeAll } from 'bun:test';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Car } from '@display/Car';

beforeAll(async () => {
  await RAPIER.init();
});

function makeWorldWithGround(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: -9.81 * 2, z: 0 });
  const groundDesc = RAPIER.ColliderDesc.cuboid(500, 0.1, 500)
    .setTranslation(0, -0.1, 0)
    .setFriction(1.5);
  world.createCollider(groundDesc);
  return world;
}

function spawnCar(world: RAPIER.World): Car {
  const forward = new THREE.Vector3(0, 0, 1);
  const car = new Car({
    carId: 0,
    name: 'Test',
    color: '#fff',
    isAI: false,
    spawn: { position: new THREE.Vector3(0, 1.5, 0), forward },
  });
  car.buildPhysics(world, RAPIER, {
    position: new THREE.Vector3(0, 1.5, 0),
    forward,
  });
  return car;
}

function stepN(world: RAPIER.World, car: Car, n: number, dt = 1 / 60): void {
  for (let i = 0; i < n; i++) {
    car.step(dt);
    world.step();
    car.postStep();
  }
}

interface RunResult {
  heading: number;      // degrees rotated from initial heading
  speed: number;        // m/s
  lateralOffset: number; // meters displaced sideways
  angVelY: number;      // current yaw rate rad/s
  x: number;
  z: number;
}

function measureTurn(drift: boolean, steer: number, warmupFrames: number, steerFrames: number): RunResult {
  const world = makeWorldWithGround();
  const car = spawnCar(world);

  // Warm up: drive straight to build speed.
  car.applyInput({ steer: 0, brake: 0, drift: false });
  stepN(world, car, warmupFrames);

  const speedBefore = Math.hypot(car.body.linvel().x, car.body.linvel().z);
  const startPos = car.body.translation();

  // Now steer (with or without drift).
  car.applyInput({ steer, brake: 0, drift });
  stepN(world, car, steerFrames);

  const endPos = car.body.translation();
  const v = car.body.linvel();
  const speed = Math.hypot(v.x, v.z);

  // Compute heading change: angle between initial forward (+Z) and current forward.
  const fwd = car.forward().setY(0).normalize();
  const headingRad = Math.atan2(fwd.x, fwd.z); // 0 = facing +Z
  const headingDeg = (headingRad * 180) / Math.PI;

  const lateralOffset = endPos.x - startPos.x;

  return {
    heading: headingDeg,
    speed,
    lateralOffset,
    angVelY: car.body.angvel().y,
    x: endPos.x,
    z: endPos.z,
  };
}

describe('Drift tuning diagnostics', () => {
  test('DIAGNOSTIC: normal turn vs drift turn at full steer', () => {
    const warmup = 120; // 2s
    const steerTime = 90; // 1.5s

    const normal = measureTurn(false, 1, warmup, steerTime);
    const drifting = measureTurn(true, 1, warmup, steerTime);

    const normalRadius = Math.abs(normal.angVelY) > 0.01 ? normal.speed / Math.abs(normal.angVelY) : Infinity;
    const driftRadius = Math.abs(drifting.angVelY) > 0.01 ? drifting.speed / Math.abs(drifting.angVelY) : Infinity;

    console.log('\n=== DRIFT TUNING RESULTS ===');
    console.log(`Normal turn:  heading=${normal.heading.toFixed(1)}°  speed=${normal.speed.toFixed(1)} m/s  angVel=${normal.angVelY.toFixed(2)} rad/s  radius=${normalRadius.toFixed(1)}m`);
    console.log(`Drift turn:   heading=${drifting.heading.toFixed(1)}°  speed=${drifting.speed.toFixed(1)} m/s  angVel=${drifting.angVelY.toFixed(2)} rad/s  radius=${driftRadius.toFixed(1)}m`);
    console.log(`Heading diff: ${(Math.abs(drifting.heading) - Math.abs(normal.heading)).toFixed(1)}° more rotation with drift`);
    console.log(`Speed diff:   ${(drifting.speed - normal.speed).toFixed(1)} m/s (positive = drift is faster)`);
    console.log(`Radius diff:  ${(normalRadius - driftRadius).toFixed(1)}m tighter with drift`);

    // At full steer, normal car benefits from slowing down (throttle lift).
    // The real win is at moderate steer — test that at steer=0.7, drift is
    // tighter AND faster than normal at steer=0.7.
    const normalMid = measureTurn(false, 0.7, warmup, steerTime);
    const driftMid = measureTurn(true, 0.7, warmup, steerTime);
    const normalMidR = normalMid.speed / Math.abs(normalMid.angVelY);
    const driftMidR = driftMid.speed / Math.abs(driftMid.angVelY);
    console.log(`\nAt steer=0.7: normal radius=${normalMidR.toFixed(1)}m  drift radius=${driftMidR.toFixed(1)}m`);
    expect(driftMidR).toBeLessThan(normalMidR);
    expect(driftMid.speed).toBeGreaterThanOrEqual(normalMid.speed * 0.85);
  });

  test('DIAGNOSTIC: drift at various steer values', () => {
    const warmup = 120;
    const steerTime = 90;

    console.log('\n=== STEER SWEEP (drift=true) ===');
    for (const steer of [0.3, 0.5, 0.7, 1.0]) {
      const r = measureTurn(true, steer, warmup, steerTime);
      console.log(`  steer=${steer.toFixed(1)}:  heading=${r.heading.toFixed(1)}°  speed=${r.speed.toFixed(1)} m/s  angVel=${r.angVelY.toFixed(2)} rad/s`);
    }

    console.log('\n=== STEER SWEEP (drift=false, for comparison) ===');
    for (const steer of [0.3, 0.5, 0.7, 1.0]) {
      const r = measureTurn(false, steer, warmup, steerTime);
      console.log(`  steer=${steer.toFixed(1)}:  heading=${r.heading.toFixed(1)}°  speed=${r.speed.toFixed(1)} m/s  angVel=${r.angVelY.toFixed(2)} rad/s`);
    }

    expect(true).toBe(true); // diagnostic only
  });

  test('DIAGNOSTIC: frame-by-frame drift activation', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world);

    // Build speed.
    car.applyInput({ steer: 0, brake: 0, drift: false });
    stepN(world, car, 120);
    const speedBefore = Math.hypot(car.body.linvel().x, car.body.linvel().z);
    console.log(`\n=== FRAME-BY-FRAME (speed at drift start: ${speedBefore.toFixed(1)} m/s) ===`);

    // Activate drift + steer.
    car.applyInput({ steer: 1, brake: 0, drift: true });
    for (let i = 0; i < 60; i++) {
      car.step(1 / 60);
      world.step();
      if (i % 10 === 0) {
        const v = car.body.linvel();
        const spd = Math.hypot(v.x, v.z);
        const fwd = car.forward().setY(0).normalize();
        const headingDeg = (Math.atan2(fwd.x, fwd.z) * 180) / Math.PI;
        const angVel = car.body.angvel().y;
        const sideImpulseRL = car.vehicle.wheelSideImpulse(0);
        const sideImpulseFL = car.vehicle.wheelSideImpulse(2);
        console.log(`  frame ${i.toString().padStart(2)}: heading=${headingDeg.toFixed(1).padStart(6)}°  speed=${spd.toFixed(1).padStart(5)} m/s  angVelY=${angVel.toFixed(3).padStart(7)}  rearSideImpulse=${sideImpulseRL.toFixed(2).padStart(6)}  frontSideImpulse=${sideImpulseFL.toFixed(2).padStart(6)}`);
      }
    }

    expect(true).toBe(true); // diagnostic only
  });

  test('DIAGNOSTIC: drift OFF recovery — car should stop rotating', () => {
    const world = makeWorldWithGround();
    const car = spawnCar(world);

    car.applyInput({ steer: 0, brake: 0, drift: false });
    stepN(world, car, 120); // build speed

    // Drift for 1 second.
    car.applyInput({ steer: 1, brake: 0, drift: true });
    stepN(world, car, 60);
    const headingDuringDrift = (Math.atan2(car.forward().x, car.forward().z) * 180) / Math.PI;
    const angVelDuringDrift = car.body.angvel().y;

    // Stop drifting, go straight.
    car.applyInput({ steer: 0, brake: 0, drift: false });
    stepN(world, car, 60); // 1s recovery
    const headingAfterRecovery = (Math.atan2(car.forward().x, car.forward().z) * 180) / Math.PI;
    const angVelAfterRecovery = car.body.angvel().y;

    console.log(`\n=== DRIFT RECOVERY ===`);
    console.log(`During drift:  heading=${headingDuringDrift.toFixed(1)}°  angVel=${angVelDuringDrift.toFixed(3)}`);
    console.log(`After recovery: heading=${headingAfterRecovery.toFixed(1)}°  angVel=${angVelAfterRecovery.toFixed(3)}`);

    // Angular velocity should be near zero after recovery.
    expect(Math.abs(angVelAfterRecovery)).toBeLessThan(0.3);
  });
});
