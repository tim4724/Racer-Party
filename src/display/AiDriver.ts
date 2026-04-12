// AiDriver — dumb waypoint follower.
//
// Aims at a point a few waypoints ahead, computes signed angle error,
// maps that to steering, and brakes when the angle error is too large
// (anticipating a corner). No pathfinding, no personality yet.

import * as THREE from 'three';
import type { Car } from './Car';
import type { Track } from './Track';
import type { InputState } from '@shared/protocol';

const LOOK_AHEAD = 6; // waypoints
const STEER_GAIN = 2.5;
const AI_MAX_BRAKE = 0.9;

// Stuck detection: if the car's speed has stayed below this threshold for
// longer than STUCK_TIME seconds, AI cars are teleported back to the nearest
// centerline waypoint. The check assumes the AI is called once per fixed
// physics step (1/60 s).
const STUCK_SPEED = 1.0;
const STUCK_TIME = 2.0;
const STUCK_DT = 1 / 60;

export class AiDriver {
  car: Car;
  track: Track;

  constructor(car: Car, track: Track) {
    this.car = car;
    this.track = track;
  }

  // Low-passed brake output. AI used to flip brake on/off across hard angle
  // thresholds (0.55, 0.9), which made cars stutter forward/backward as the
  // angle hovered around them. Now we map angle → brake continuously and
  // smooth the result over time.
  private smoothedBrake = 0;

  // Stuck timer — accumulated seconds with speed < STUCK_SPEED. Reset to 0
  // every time the car moves above the threshold OR after a respawn.
  private stuckTime = 0;

  computeInput(): InputState {
    const t = this.car.body.translation();
    // Use the car's actual y — the closest-waypoint search is 3D so the
    // bridge pass (y ≈ BRIDGE_HEIGHT) and the under-pass (y ≈ 0) stay
    // disambiguated at the figure-8 crossing.
    const pos = new THREE.Vector3(t.x, t.y, t.z);

    // Stuck detection: if the car has been moving below STUCK_SPEED for
    // longer than STUCK_TIME, teleport it back to the closest centerline
    // waypoint, facing the next one. Skipped while the race hasn't actually
    // started — Car.input.brake is forced to 1 during the countdown.
    if (this.car.speed < STUCK_SPEED) {
      this.stuckTime += STUCK_DT;
    } else {
      this.stuckTime = 0;
    }
    if (this.stuckTime >= STUCK_TIME) {
      this.respawnAtClosestWaypoint(pos);
      this.stuckTime = 0;
      return { steer: 0, brake: 0 };
    }

    const closestIdx = this.track.closestWaypointIndex(pos);
    const targetIdx = (closestIdx + LOOK_AHEAD) % this.track.centerline.length;
    const target = this.track.centerline[targetIdx];

    const toTarget = target.clone().sub(pos).setY(0);
    if (toTarget.lengthSq() < 0.001) return { steer: 0, brake: 0 };
    toTarget.normalize();

    const forward = this.car.forward().setY(0).normalize();
    // 2D cross of forward × toTarget in the XZ plane.
    const cross = forward.x * toTarget.z - forward.z * toTarget.x;
    const dot = THREE.MathUtils.clamp(forward.dot(toTarget), -1, 1);
    const angle = Math.acos(dot);
    // Input convention: +1 = right of forward (where right = forward × up).
    // In our right-handed XZ projection, target is to the right of forward
    // when `cross > 0`, so emit positive steer in that case.
    const signed = cross > 0 ? angle : -angle;

    const steer = THREE.MathUtils.clamp(signed * STEER_GAIN, -1, 1);

    // Continuous brake ramp from angle, capped at AI_MAX_BRAKE.
    let rawBrake = THREE.MathUtils.clamp((angle - 0.4) / 0.6, 0, AI_MAX_BRAKE);
    if (this.car.speed > 22 && angle > 0.3) {
      const speedFactor = THREE.MathUtils.clamp((this.car.speed - 22) / 8, 0, 1);
      const angleFactor = THREE.MathUtils.clamp((angle - 0.3) / 0.4, 0, 1);
      rawBrake = Math.max(rawBrake, 0.25 * speedFactor * angleFactor);
    }

    // Slow low-pass — 8% per step ≈ 200 ms convergence. Slow enough that
    // brief target wobbles can never produce visible mode changes.
    this.smoothedBrake += (rawBrake - this.smoothedBrake) * 0.08;

    return { steer, brake: this.smoothedBrake };
  }

  private respawnAtClosestWaypoint(pos: THREE.Vector3): void {
    const idx = this.track.closestWaypointIndex(pos);
    const N = this.track.centerline.length;
    const here = this.track.centerline[idx];
    const next = this.track.centerline[(idx + 1) % N];
    const forward = next.clone().sub(here);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1);
    forward.normalize();
    this.car.respawnAt(here, forward);
    this.smoothedBrake = 0;
  }
}
