// Car — wraps a Rapier raycast vehicle controller and a Three.js mesh.
//
// One Car per slot in the race. Inputs come from either a remote phone
// (via DisplayConnection) or an AiDriver. Throttle is auto-forward when
// not braking; steering and brake are continuous values in [-1..1] and
// [0..1] respectively.
//
// Two drive modes (`CarMode`): drive / reverse. Each step picks exactly
// one based on current speed + input, with hysteresis on every threshold
// so the mode never flickers between frames. See updateMode() for the
// full state machine.

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { InputState } from '@shared/protocol';

type RapierModule = typeof RAPIER;

// Reusable temp objects for syncMesh interpolation (avoids GC churn).
const _tmpVec = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();

const CHASSIS_HALF = { x: 1.0, y: 0.4, z: 2.0 };
const WHEEL_RADIUS = 0.4;
const SUSPENSION_REST = 0.5;
// Vertical offset applied to the visual body (chassis + cabin + hood + etc.)
// so the chassis sits ABOVE the wheels instead of engulfing them. Wheels
// are positioned directly from the vehicle controller's suspension state;
// this shift is purely cosmetic and has no effect on physics. Tuned so the
// chassis bottom lines up roughly with the tops of the tires.
const BODY_VISUAL_LIFT = 0.2;
const MAX_ENGINE_FORCE = 270;
const MAX_REVERSE_FORCE = 150; // reverse is roughly half-speed of forward
// Brake force directly bites into the wheels via friction. Even small
// values are amplified by tire grip → large effective deceleration. We
// target a peak of ~12 m/s² (~1.2g) at brake=1, which feels firm without
// being whiplash. Lower this further if it still feels harsh.
const MAX_BRAKE_FORCE = 2;
const MAX_STEER_RAD = 0.55;
// Brake input at which the throttle is fully cut. Below this value, throttle
// blends down linearly so a small brake input feels like easing off the gas
// rather than slamming on the brakes.
const THROTTLE_CUTOFF = 0.6;
// At full steering lock, throttle drops to (1 - STEER_THROTTLE_LIFT) of max.
// Helps the car turn into corners instead of plowing straight on at full
// gas — a classic arcade-racer assist. 0 disables the lift.
const STEER_THROTTLE_LIFT = 0.35;

// --- Drive modes ----------------------------------------------------------
// Each step the car is in exactly one of two modes (see CarMode below).
// Transitions are gated by hysteresis on every threshold so an input or
// speed value hovering near a single number can't flip the mode every
// frame and produce a visible forward/backward stutter.
//
//   drive  – default. Throttle blends with brake; high steer reduces
//            throttle (turn-in assist). Brake force decelerates while
//            going forward.
//   reverse – stopped or moving backward AND brake held. Negative engine
//            force pulls the car backward; steering still works.
const STEER_INPUT_ENTER = 0.18;
const STEER_INPUT_EXIT  = 0.08;
const REVERSE_ENTER_SPEED = 0.3;
const REVERSE_EXIT_SPEED  = 1.5;

const FLIP_THRESHOLD = 0.3;
const FLIP_RECOVERY_TIME = 1.5;

// --- Drift (pure cheat) -----------------------------------------------------
const DRIFT_RAMP_SPEED = 6.67;        // blend 0→1 in ~0.15s
// Drift activation — display-authoritative.
//   - Firm steer input (past the dead zone / detent) in either direction
//   - Brake held (binary in today's controller, but we check > 0.5 in case)
//   - Moving fast enough to actually drift, not spin from a standstill
// Once a drift is in progress (blend > 0) the speed gate lifts so losing
// speed mid-drift doesn't kill it — only releasing the inputs does.
const DRIFT_STEER_MIN = 0.25;
const DRIFT_BRAKE_MIN = 0.5;
const DRIFT_MIN_SPEED = 100 / 3.6;    // 100 km/h ≈ 27.78 m/s
// Tunable at runtime via driftTuning (debug sliders).
export const driftTuning = {
  extraRadius: 130,    // extra turn radius in meters at full steer
};

type CarMode = 'drive' | 'reverse';

export interface CarOptions {
  carId: number;
  name: string;
  color: string;
  isAI: boolean;
  spawn: { position: THREE.Vector3; forward: THREE.Vector3 };
}

export class Car {
  carId: number;
  name: string;
  color: string;
  isAI: boolean;

  // Race state
  lap = 0;
  lastCheckpointIndex = -1;
  visitedThisLap = new Set<number>();
  currentLapStartTime = 0;
  totalTime = 0;
  placement = 0;
  finished = false;

  // Upside-down recovery: tracks how long the chassis has been tilted past
  // FLIP_THRESHOLD. Once it exceeds FLIP_RECOVERY_TIME, the car is snapped
  // back upright at its current XZ position with zero velocity.
  private flippedTime = 0;

  // Current drive mode. Only mutated by updateMode().
  private mode: CarMode = 'drive';
  private steeringActive = false;
  // Render interpolation: previous-frame body state used to smooth the
  // visual mesh between fixed-timestep physics ticks. Without this, the
  // car visually stutters on high-refresh displays (120Hz) where ~2
  // render frames happen per 60Hz physics step.
  private prevPosition = new THREE.Vector3();
  private prevQuaternion = new THREE.Quaternion();

  // Sim
  body!: RAPIER.RigidBody;
  collider!: RAPIER.Collider;
  vehicle!: RAPIER.DynamicRayCastVehicleController;

  // Visual
  mesh: THREE.Group;
  // Sub-group holding every non-wheel visual piece, offset upward by
  // BODY_VISUAL_LIFT so the shell sits above the wheels.
  bodyGroup!: THREE.Group;
  chassisMesh!: THREE.Mesh;
  wheelMeshes: THREE.Mesh[] = [];

  // Latest input from phone/AI/keyboard
  input: InputState = { steer: 0, brake: 0 };
  // 0 = normal grip, 1 = full drift. Ramps in, snaps out.
  private driftBlend = 0;
  // Read-only view for the HUD.
  get isDrifting(): boolean { return this.driftBlend > 0; }
  // Speed captured when drift activates — preserved throughout the drift.
  private driftSpeed = 0;

  // Cached for HUD: speed in m/s, derived each step.
  speed = 0;

  constructor(options: CarOptions) {
    this.carId = options.carId;
    this.name = options.name;
    this.color = options.color;
    this.isAI = options.isAI;

    this.mesh = new THREE.Group();

    // All non-wheel visuals live under this group so a single y offset
    // lifts the entire shell above the wheels.
    this.bodyGroup = new THREE.Group();
    this.bodyGroup.position.y = BODY_VISUAL_LIFT;
    this.mesh.add(this.bodyGroup);

    // Main chassis — body color.
    const chassisGeo = new THREE.BoxGeometry(CHASSIS_HALF.x * 2, CHASSIS_HALF.y * 2, CHASSIS_HALF.z * 2);
    const chassisMat = new THREE.MeshLambertMaterial({ color: options.color });
    this.chassisMesh = new THREE.Mesh(chassisGeo, chassisMat);
    this.bodyGroup.add(this.chassisMesh);

    // Hood bulge — slightly raised block over the front half, same color.
    // Bottom shifted +0.02 above the chassis top to prevent z-fighting on
    // the seam (was bottom == chassis top, which flickered when moving).
    const hoodGeo = new THREE.BoxGeometry(CHASSIS_HALF.x * 1.7, 0.18, CHASSIS_HALF.z * 0.9);
    const hood = new THREE.Mesh(hoodGeo, chassisMat);
    hood.position.set(0, CHASSIS_HALF.y + 0.09 + 0.02, CHASSIS_HALF.z * 0.55);
    this.bodyGroup.add(hood);

    // Cabin / greenhouse — dark, set back from the hood. Same +0.02 lift.
    const cabinGeo = new THREE.BoxGeometry(CHASSIS_HALF.x * 1.55, 0.55, CHASSIS_HALF.z * 0.95);
    const cabinMat = new THREE.MeshLambertMaterial({ color: 0x1a1a20 });
    const cabin = new THREE.Mesh(cabinGeo, cabinMat);
    cabin.position.set(0, CHASSIS_HALF.y + 0.275 + 0.02, -CHASSIS_HALF.z * 0.05);
    this.bodyGroup.add(cabin);

    // Rear wing — thin slab held above the rear with two posts.
    const wingMat = new THREE.MeshLambertMaterial({ color: 0x111114 });
    const wingGeo = new THREE.BoxGeometry(CHASSIS_HALF.x * 2.1, 0.06, 0.35);
    const wing = new THREE.Mesh(wingGeo, wingMat);
    wing.position.set(0, CHASSIS_HALF.y + 0.65, -CHASSIS_HALF.z * 0.92);
    this.bodyGroup.add(wing);
    const postGeo = new THREE.BoxGeometry(0.1, 0.55, 0.15);
    for (const sx of [-CHASSIS_HALF.x * 0.75, CHASSIS_HALF.x * 0.75]) {
      const post = new THREE.Mesh(postGeo, wingMat);
      post.position.set(sx, CHASSIS_HALF.y + 0.35, -CHASSIS_HALF.z * 0.92);
      this.bodyGroup.add(post);
    }

    // Headlights — pale-yellow panels on the front face. Pushed forward by
    // half-depth + a small gap so the entire light box sits OUTSIDE the
    // chassis cuboid (no overlap = no z-fighting on the front face). The
    // old z = CHASSIS_HALF.z + 0.01 placed the light center 0.01 m forward
    // of the chassis face, but the box's depth (0.08) extended back into
    // the chassis by 0.03 m → flickering surfaces.
    const lightGeo = new THREE.BoxGeometry(0.42, 0.25, 0.08);
    const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff4a8 });
    for (const sx of [-CHASSIS_HALF.x * 0.55, CHASSIS_HALF.x * 0.55]) {
      const light = new THREE.Mesh(lightGeo, headlightMat);
      light.position.set(sx, 0.05, CHASSIS_HALF.z + 0.05);
      this.bodyGroup.add(light);
    }

    // Brake lights — red panels on the rear face, fully outside the chassis.
    const brakeMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
    for (const sx of [-CHASSIS_HALF.x * 0.55, CHASSIS_HALF.x * 0.55]) {
      const light = new THREE.Mesh(lightGeo, brakeMat);
      light.position.set(sx, 0.05, -CHASSIS_HALF.z - 0.05);
      this.bodyGroup.add(light);
    }

    // Wheels — parented to the top-level mesh (NOT the body group) so they
    // stay aligned with the physics suspension state rather than being
    // lifted with the shell.
    const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
    for (let i = 0; i < 4; i++) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      this.wheelMeshes.push(wheel);
      this.mesh.add(wheel);
    }
  }

  // Adds chassis + collider to the world. Spawn position/orientation comes from Track.
  buildPhysics(
    world: RAPIER.World,
    RAPIER: RapierModule,
    spawn: { position: THREE.Vector3; forward: THREE.Vector3 },
  ): void {
    const yaw = Math.atan2(spawn.forward.x, spawn.forward.z);
    const halfYaw = yaw / 2;
    const rot = { x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) };

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
      .setRotation(rot)
      // Linear damping balances engine force at top speed.
      .setLinearDamping(0.10)
      // Higher angular damping = more resistance to pitching/rolling, so the
      // chassis doesn't flip during hard braking or wall scrapes.
      .setAngularDamping(1.5)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc.cuboid(CHASSIS_HALF.x, CHASSIS_HALF.y, CHASSIS_HALF.z)
      .setDensity(8.0)
      .setFriction(0.6)
      // Restitution 0 — the chassis must NOT bounce off walls. Contact
      // bounce + the auto-throttle pushing forward = visible vibration
      // when scraping along a wall. Default combine rule (Average) is
      // intentional: wall has restitution 0.2, contact = 0.1 — small
      // enough that the chassis sticks instead of trampolining.
      .setRestitution(0.0)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.collider = world.createCollider(colDesc, this.body);

    this.vehicle = world.createVehicleController(this.body);

    const suspensionDir = { x: 0, y: -1, z: 0 };
    const axleDir = { x: -1, y: 0, z: 0 };
    const wheelOffsets = [
      { x: -CHASSIS_HALF.x, y: -CHASSIS_HALF.y * 0.5, z: -CHASSIS_HALF.z * 0.7 }, // RL
      { x: CHASSIS_HALF.x, y: -CHASSIS_HALF.y * 0.5, z: -CHASSIS_HALF.z * 0.7 }, // RR
      { x: -CHASSIS_HALF.x, y: -CHASSIS_HALF.y * 0.5, z: CHASSIS_HALF.z * 0.7 }, // FL
      { x: CHASSIS_HALF.x, y: -CHASSIS_HALF.y * 0.5, z: CHASSIS_HALF.z * 0.7 }, // FR
    ];
    for (const off of wheelOffsets) {
      this.vehicle.addWheel(off, suspensionDir, axleDir, SUSPENSION_REST, WHEEL_RADIUS);
    }
    // Tune wheels for an arcade feel.
    // friction_slip controls grip. Per Rapier's docs: "the larger the value,
    // the more instantaneous braking will happen, with the risk of causing
    // the vehicle to flip if it's too strong." 4.5 was flipping the car on
    // hard stops; 2.0 still feels grippy without lifting the rear wheels.
    for (let i = 0; i < 4; i++) {
      this.vehicle.setWheelSuspensionStiffness(i, 30);
      this.vehicle.setWheelMaxSuspensionTravel(i, 0.5);
      this.vehicle.setWheelFrictionSlip(i, 2.0);
      this.vehicle.setWheelSideFrictionStiffness(i, 1.0);
    }
  }

  applyInput(input: InputState): void {
    this.input = input;
  }

  // Freeze the car in place during the countdown. Applies brake force to all
  // wheels but never engages reverse engine force, regardless of input.
  // Front-wheel steering still tracks the player's input so they can preset
  // their turn angle before the race starts.
  stepFrozen(dt: number): void {
    const steer = -this.input.steer * MAX_STEER_RAD;
    for (let i = 0; i < 4; i++) {
      // Front wheels (2, 3) follow input; rears stay straight.
      this.vehicle.setWheelSteering(i, i >= 2 ? steer : 0);
      this.vehicle.setWheelEngineForce(i, 0);
      this.vehicle.setWheelBrake(i, MAX_BRAKE_FORCE);
    }
    this.vehicle.updateVehicle(dt);
    const v = this.body.linvel();
    this.speed = Math.hypot(v.x, v.z);
  }

  // Called once per fixed step. dt is consumed by the vehicle controller.
  step(dt: number): void {
    if (this.finished) {
      this.applyForcesIdle();
      this.vehicle.updateVehicle(dt);
      return;
    }

    // 0. Drift blend: ramp in, snap out. Derived purely from physics state
    //    + raw inputs; a low-speed crawl can't accidentally spin the car out.
    const vel0 = this.body.linvel();
    const speed0 = Math.hypot(vel0.x, vel0.z);
    const driftActive = this.driftBlend > 0;
    const steerHeld = Math.abs(this.input.steer) > DRIFT_STEER_MIN;
    const brakeHeld = this.input.brake > DRIFT_BRAKE_MIN;
    const fastEnough = driftActive || speed0 >= DRIFT_MIN_SPEED;
    const wantDrift = steerHeld && brakeHeld && fastEnough;

    const wasDrifting = driftActive;
    if (wantDrift) {
      this.driftBlend = Math.min(1, this.driftBlend + DRIFT_RAMP_SPEED * dt);
    } else {
      this.driftBlend = 0;
    }

    // Capture speed when drift starts.
    if (this.driftBlend > 0 && !wasDrifting) {
      this.driftSpeed = speed0;
    }

    // 1. Front-wheel steering — normal, unmodified.
    const steerMag = Math.abs(this.input.steer);
    this.vehicle.setWheelSteering(2, -this.input.steer * MAX_STEER_RAD);
    this.vehicle.setWheelSteering(3, -this.input.steer * MAX_STEER_RAD);

    // 2. Read body state.
    const v = this.body.linvel();
    const fwd = this.forward();
    const forwardSpeed = fwd.x * v.x + fwd.z * v.z;
    const brakeInput = this.input.brake;

    // 3. Update derived state with hysteresis.
    if (this.steeringActive) {
      if (steerMag < STEER_INPUT_EXIT) this.steeringActive = false;
    } else if (steerMag >= STEER_INPUT_ENTER) {
      this.steeringActive = true;
    }
    this.updateMode(forwardSpeed, brakeInput);

    // 4. Compute the two actuator outputs from the current mode.
    let engineForce = 0;
    let brakeForce = 0;
    switch (this.mode) {
      case 'reverse':
        engineForce = -brakeInput * MAX_REVERSE_FORCE;
        break;
      case 'drive': {
        const effectiveBrake = this.steeringActive ? 0 : brakeInput;
        const throttleScale = Math.max(0, 1 - effectiveBrake / THROTTLE_CUTOFF)
          * (1 - steerMag * STEER_THROTTLE_LIFT);
        engineForce = MAX_ENGINE_FORCE * throttleScale;
        brakeForce = effectiveBrake * MAX_BRAKE_FORCE;
        break;
      }
    }

    // Airborne guard.
    const frontGrounded =
      this.vehicle.wheelIsInContact(2) && this.vehicle.wheelIsInContact(3);
    if (!frontGrounded && engineForce > 0) engineForce = 0;

    // 5. Apply outputs.
    this.vehicle.setWheelEngineForce(0, engineForce);
    this.vehicle.setWheelEngineForce(1, engineForce);
    for (let i = 0; i < 4; i++) this.vehicle.setWheelBrake(i, brakeForce);

    // During drift, reduce side friction so Rapier doesn't fight the velocity
    // rotation in postStep. Speed loss is handled by postStep's preservation.
    if (this.driftBlend > 0) {
      const sf = 1.0 - 0.7 * this.driftBlend; // 1.0 → 0.3
      for (let i = 0; i < 4; i++) this.vehicle.setWheelSideFrictionStiffness(i, sf);
    } else {
      for (let i = 0; i < 4; i++) this.vehicle.setWheelSideFrictionStiffness(i, 1.0);
    }

    this.vehicle.updateVehicle(dt);

    this.speed = Math.hypot(v.x, v.z);
    this.checkFlipRecovery(dt);
  }

  // Called by RaceSim AFTER world.step(). Pure cheat drift:
  // Normal physics runs untouched. We then rotate the velocity vector by
  // an extra amount in the steer direction and preserve speed. That's it.
  //
  // - The heading follows naturally via wheel side friction.
  // - The drift angle = gap between velocity (rotated ahead) and heading
  //   (catching up) — the rear visually breaks out.
  // - Speed is preserved so turning doesn't cost energy.
  postStep(): void {
    if (this.driftBlend <= 0) return;
    // Skip drift when airborne — no wheels on the ground means no drift.
    const grounded =
      this.vehicle.wheelIsInContact(0) || this.vehicle.wheelIsInContact(1) ||
      this.vehicle.wheelIsInContact(2) || this.vehicle.wheelIsInContact(3);
    if (!grounded) return;
    const db = this.driftBlend;

    const vel = this.body.linvel();
    const speed = Math.hypot(vel.x, vel.z);
    if (speed < 2) return;

    // 1. Rotate velocity vector extra in steer direction.
    //    extraTurn = speed / extraRadius — same radius at any speed.
    const dt = 1 / 60;
    const extraTurn = speed / Math.max(1, driftTuning.extraRadius);
    const angle = this.input.steer * extraTurn * db * dt;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let vx = vel.x * cos - vel.z * sin;
    let vz = vel.x * sin + vel.z * cos;

    // 2. Preserve speed — but accept sudden drops (wall hits).
    //    If current speed dropped below 70% of drift speed, adopt the lower
    //    speed as the new baseline instead of forcing it back up.
    if (speed < this.driftSpeed * 0.7) {
      this.driftSpeed = speed;
    }
    const targetSpeed = Math.max(this.driftSpeed, speed);
    const newSpeed = Math.hypot(vx, vz);
    if (newSpeed > 0.1) {
      const s = targetSpeed / newSpeed;
      vx *= s;
      vz *= s;
    }

    this.body.setLinvel({ x: vx, y: vel.y, z: vz }, true);
    this.speed = targetSpeed;
  }

  // State machine for `mode`. Each transition has hysteresis so a single
  // threshold cross can't toggle the mode every frame.
  private updateMode(forwardSpeed: number, brakeInput: number): void {
    switch (this.mode) {
      case 'reverse':
        if (forwardSpeed > REVERSE_EXIT_SPEED || brakeInput < 0.05) {
          this.mode = 'drive';
        }
        break;
      case 'drive':
        if (forwardSpeed < REVERSE_ENTER_SPEED && brakeInput >= 0.5) {
          this.mode = 'reverse';
        }
        break;
    }
  }

  // If the chassis has been tilted past FLIP_THRESHOLD for longer than
  // FLIP_RECOVERY_TIME, snap it back upright at its current XZ position with
  // zero velocity. Yaw is preserved if possible (computed from current
  // forward direction projected onto the ground), otherwise the original
  // spawn yaw is used.
  private checkFlipRecovery(dt: number): void {
    const r = this.body.rotation();
    // Up vector of the chassis = (0,1,0) rotated by body quat. Y component
    // alone tells us how upright we are: 1 = perfectly upright, 0 = on its
    // side, -1 = upside down.
    const upY =
      1 - 2 * (r.x * r.x + r.z * r.z); // (Q · (0,1,0)).y, expanded
    if (upY < FLIP_THRESHOLD) {
      this.flippedTime += dt;
    } else {
      this.flippedTime = 0;
    }
    if (this.flippedTime >= FLIP_RECOVERY_TIME) {
      this.respawnUpright();
      this.flippedTime = 0;
    }
  }

  // Snap the body upright at its current XZ, lifted slightly above the
  // ground, with zero velocity. Yaw is recovered from the projected forward
  // vector so the car keeps facing roughly where it was going.
  respawnUpright(): void {
    const t = this.body.translation();
    const fwd = this.forward();
    // Project forward onto XZ plane; fall back to +Z if degenerate.
    let yaw = Math.atan2(fwd.x, fwd.z);
    if (!Number.isFinite(yaw)) yaw = 0;
    const half = yaw / 2;
    const rot = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
    this.body.setTranslation({ x: t.x, y: 1.5, z: t.z }, true);
    this.body.setRotation(rot, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  // Snap the body to an arbitrary world position with a given forward vector.
  // Used by AI stuck-recovery to teleport to the nearest centerline waypoint.
  // The Y component of `position` is treated as the road surface; the chassis
  // is lifted above it so wheels don't intersect the ground at spawn.
  respawnAt(position: THREE.Vector3, forward: THREE.Vector3): void {
    const fwd = forward.clone();
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const yaw = Math.atan2(fwd.x, fwd.z);
    const half = yaw / 2;
    const rot = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
    this.body.setTranslation({ x: position.x, y: position.y + 1.5, z: position.z }, true);
    this.body.setRotation(rot, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  private applyForcesIdle(): void {
    for (let i = 0; i < 4; i++) {
      this.vehicle.setWheelEngineForce(i, 0);
      this.vehicle.setWheelBrake(i, MAX_BRAKE_FORCE * 0.5);
      this.vehicle.setWheelSteering(i, 0);
    }
  }

  // Snapshot the body's current state so the next syncMesh can interpolate
  // between "before this physics step" and "after". Called once per physics
  // tick, BEFORE the tick runs, by RaceSim.stepFixed.
  savePrevState(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.prevPosition.set(t.x, t.y, t.z);
    this.prevQuaternion.set(r.x, r.y, r.z, r.w);
  }

  // Sync the Three.js mesh from the Rapier transforms. Called every RENDER
  // frame (which can be faster than the 60Hz physics step on a 120Hz
  // display). `alpha` ∈ [0, 1] is the fraction of a physics step elapsed
  // since the last tick; 0 = render right at the last step, 1 = render
  // right before the next step. Interpolating by alpha smooths out the
  // visual position so the car doesn't stutter on high-refresh displays.
  syncMesh(alpha: number): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    const curPos = _tmpVec.set(t.x, t.y, t.z);
    const curQuat = _tmpQuat.set(r.x, r.y, r.z, r.w);

    this.mesh.position.lerpVectors(this.prevPosition, curPos, alpha);
    this.mesh.quaternion.slerpQuaternions(this.prevQuaternion, curQuat, alpha);

    // Drift visual: rotate the mesh extra into the turn so the rear
    // visually breaks out. ~15° at full steer + full blend.
    if (this.driftBlend > 0) {
      const driftYaw = -this.input.steer * this.driftBlend * 0.07; // ~4°
      _tmpQuat.setFromAxisAngle(_tmpVec.set(0, 1, 0), driftYaw);
      this.mesh.quaternion.multiply(_tmpQuat);
    }

    // Wheels: read each wheel's chassis-local position from the vehicle controller.
    for (let i = 0; i < 4; i++) {
      const w = this.wheelMeshes[i];
      const cs = this.vehicle.wheelChassisConnectionPointCs(i);
      const susp = this.vehicle.wheelSuspensionLength(i);
      if (!cs) continue;
      const restLen = SUSPENSION_REST;
      const drop = (susp ?? restLen) - restLen;
      w.position.set(cs.x, cs.y - drop, cs.z);

      const steerAngle = this.vehicle.wheelSteering(i) ?? 0;
      w.rotation.y = steerAngle;
    }
  }

  // Forward direction in world space. Used by AI and the chase camera.
  forward(): THREE.Vector3 {
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    return new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  }
}
