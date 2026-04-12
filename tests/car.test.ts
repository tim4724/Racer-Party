// Lightweight Car tests — covers the parts that don't need a Rapier world.
// (The full physics path is exercised by the Playwright e2e tests.)
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { Car } from '@display/Car';

function makeCar(carId = 0): Car {
  return new Car({
    carId,
    name: 'P1',
    color: '#ff7a18',
    isAI: false,
    spawn: { position: new THREE.Vector3(0, 1, 0), forward: new THREE.Vector3(0, 0, 1) },
  });
}

describe('Car (no-physics surface)', () => {
  test('applyInput stores the latest steer and brake', () => {
    const car = makeCar();
    car.applyInput({ steer: 0.5, brake: 0.2, drift: false });
    expect(car.input.steer).toBe(0.5);
    expect(car.input.brake).toBe(0.2);
    car.applyInput({ steer: -1, brake: 1, drift: false });
    expect(car.input.steer).toBe(-1);
    expect(car.input.brake).toBe(1);
  });

  test('mesh group contains a lifted body sub-group plus 4 wheels', () => {
    const car = makeCar();
    // The shell (chassis, hood, cabin, spoiler, lights) lives under a
    // body sub-group that's lifted so the wheels poke out below it.
    expect(car.mesh.children).toContain(car.bodyGroup);
    expect(car.bodyGroup.children).toContain(car.chassisMesh);
    expect(car.bodyGroup.position.y).toBeGreaterThan(0);
    // Wheels are parented to the top-level mesh (not the body group) so
    // they track the physics suspension directly.
    expect(car.wheelMeshes.length).toBe(4);
    for (const w of car.wheelMeshes) {
      expect(car.mesh.children).toContain(w);
    }
  });

  test('initial race state is zero', () => {
    const car = makeCar();
    expect(car.lap).toBe(0);
    expect(car.lastCheckpointIndex).toBe(-1);
    expect(car.placement).toBe(0);
    expect(car.finished).toBe(false);
  });
});
