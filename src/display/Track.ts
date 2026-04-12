// Hand-coded figure-8 track with a bridge over one of the crossings.
// Everything is still built from primitive Three.js + Rapier shapes:
//   - Centerline waypoints (closed loop) — now 3D, lifted by a smooth
//     Gaussian bump at one of the origin crossings to form the bridge.
//   - Road ribbon mesh (extruded plane along the centerline, y varies)
//   - Wall colliders (boxes) on both sides, rotated to follow the road
//     pitch so they ramp up onto the bridge cleanly
//   - Ground plane collider (for everything at y≈0, including the under-pass)
//   - Bridge deck colliders — thin cuboids under the elevated segments so
//     the raycast vehicle has a surface to ride on while on the bridge
//   - Checkpoint sensor colliders along the centerline
//   - Spawn grid (4 positions) on a flat section of the track
//   - Simple scenery: trees and low-poly buildings outside the track
//
// The shape is a Gerono lemniscate:
//    x = LOBE_X * cos(t)
//    z = LOBE_Z * sin(t) * cos(t)
// Two loops meeting at the origin, crossing once at t=π/2 (the bridge) and
// once at t=3π/2 (the flat under-pass). The first checkpoint (index 0) is
// the start/finish line; cars must traverse all checkpoints in order.

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

type RapierModule = typeof RAPIER;

const ROAD_WIDTH = 24;
const WALL_HEIGHT = 2.5;
const WALL_THICKNESS = 1.0;

// Figure-8 dimensions. The track is built from 8 stages stitched together:
//   - 4 horizontal straights (front/back of each lobe)
//   - 2 semicircles (far side of each lobe)
//   - 2 diagonals that cross at origin (one is the bridge, one is flat)
//
// LOBE_DISTANCE is the |x| of each lobe's semicircle center.
// LOBE_RADIUS is the semicircle radius (= half-width of the lobe in z).
// STRAIGHT_LENGTH is the length of each front/back straight.
//
// For the two diagonals to cross at exactly 90°, we need
//   STRAIGHT_LENGTH = 2 * (LOBE_DISTANCE - LOBE_RADIUS)
// which keeps the diagonal's XZ slope at ±1.
const LOBE_DISTANCE = 155;
const LOBE_RADIUS = 80;
const STRAIGHT_LENGTH = 150;

// Bridge bump on stage 2 (the NW diagonal). Parameterised in METERS of
// arc-distance along the diagonal, centered on the diagonal's midpoint
// (which is the origin in XZ). The other diagonal (stage 6) stays flat.
//   elevation(dist) = BRIDGE_HEIGHT * exp(-(dist / BRIDGE_SIGMA_M)²)
const BRIDGE_HEIGHT = 7.0;
const BRIDGE_SIGMA_M = 34;

// Deck thickness for both the visual mesh and the collider cuboid.
const DECK_THICKNESS = 0.3;
// Don't create a deck collider for segments with negligible elevation —
// the ground plane handles those.
const DECK_MIN_Y = 0.15;

// Higher sample count keeps the ribbon smooth now that the perimeter is
// ~1550 m (up from ~900 with the lemniscate at L=160).
const SAMPLE_COUNT = 320;

export interface Checkpoint {
  index: number;
  position: THREE.Vector3;
  forward: THREE.Vector3; // unit tangent in the XZ plane
}

export interface SpawnPoint {
  position: THREE.Vector3;
  forward: THREE.Vector3;
}

// Smooth Gaussian bump, parameterised on arc-distance from the diagonal's
// midpoint (in meters). Used only within the bridge diagonal (stage 2).
function bridgeElevation(distFromMid: number): number {
  return BRIDGE_HEIGHT * Math.exp(-((distFromMid / BRIDGE_SIGMA_M) ** 2));
}

// A single parametric stage of the centerline: returns XZ at arc-distance
// `s` into the stage (0 ≤ s ≤ length), and optionally a y elevation.
interface Stage {
  length: number;
  at: (s: number) => { x: number; z: number };
  elevationAt?: (s: number) => number;
}

export class Track {
  centerline: THREE.Vector3[] = [];
  checkpoints: Checkpoint[] = [];
  spawnPoints: SpawnPoint[] = [];
  // Map<colliderHandle, checkpointIndex> for sensor lookup.
  checkpointHandles = new Map<number, number>();

  constructor() {
    this.buildCenterline();
    this.buildCheckpoints();
    this.buildSpawnPoints();
  }

  // Build the centerline by arc-length sampling a sequence of 8 stages.
  // Stages are stitched together at their endpoints (continuous position,
  // though the tangent has a kink where a straight meets a diagonal).
  //
  // Top-down convention: +X right, +Z down. Lobe at +X is the "right lobe",
  // lobe at -X is the "left lobe". Each lobe has two horizontal straights
  // (+Z is "front", -Z is "back") joined by a semicircle on its far side.
  // Two diagonals cross at origin — stage 2 is the bridge, stage 6 flat.
  private buildCenterline(): void {
    const stages = this.buildStages();
    const totalLen = stages.reduce((acc, st) => acc + st.length, 0);
    const N = SAMPLE_COUNT;
    const stepLen = totalLen / N;

    const points: THREE.Vector3[] = [];
    let stageIdx = 0;
    let stageStart = 0; // cumulative arc length at start of current stage
    for (let i = 0; i < N; i++) {
      const s = i * stepLen;
      while (
        stageIdx < stages.length - 1 &&
        s >= stageStart + stages[stageIdx].length
      ) {
        stageStart += stages[stageIdx].length;
        stageIdx++;
      }
      const stage = stages[stageIdx];
      const local = s - stageStart;
      const { x, z } = stage.at(local);
      const y = stage.elevationAt ? stage.elevationAt(local) : 0;
      points.push(new THREE.Vector3(x, y, z));
    }
    this.centerline = points;
  }

  private buildStages(): Stage[] {
    const cx = LOBE_DISTANCE;
    const r = LOBE_RADIUS;
    const s = STRAIGHT_LENGTH;
    const halfS = s / 2;

    // Anchor points (refer to the 8-stage comment in buildCenterline).
    const rightFrontR = { x: cx + halfS, z: +r }; // stage 1 start
    const rightFrontL = { x: cx - halfS, z: +r }; // stage 1 end / stage 2 start
    const leftBackR = { x: -cx + halfS, z: -r };  // stage 2 end / stage 3 start
    const leftBackL = { x: -cx - halfS, z: -r };  // stage 3 end / stage 4 start
    const leftFrontL = { x: -cx - halfS, z: +r }; // stage 4 end / stage 5 start
    const leftFrontR = { x: -cx + halfS, z: +r }; // stage 5 end / stage 6 start
    const rightBackL = { x: cx - halfS, z: -r };  // stage 6 end / stage 7 start
    const rightBackR = { x: cx + halfS, z: -r };  // stage 7 end / stage 8 start

    const stages: Stage[] = [];

    // Stage 1: right-front straight, moving −X.
    stages.push({
      length: s,
      at: (t) => ({ x: rightFrontR.x - t, z: rightFrontR.z }),
    });

    // Stage 2: NW diagonal, from (cx−s/2, +r) to (−cx+s/2, −r). BRIDGE.
    const diag1Len = Math.hypot(
      leftBackR.x - rightFrontL.x,
      leftBackR.z - rightFrontL.z,
    );
    stages.push({
      length: diag1Len,
      at: (t) => {
        const a = t / diag1Len;
        return {
          x: rightFrontL.x + (leftBackR.x - rightFrontL.x) * a,
          z: rightFrontL.z + (leftBackR.z - rightFrontL.z) * a,
        };
      },
      elevationAt: (t) => bridgeElevation(t - diag1Len / 2),
    });

    // Stage 3: left-back straight, moving −X.
    stages.push({
      length: s,
      at: (t) => ({ x: leftBackR.x - t, z: leftBackR.z }),
    });

    // Stage 4: left semicircle around the far (−X) side of the left lobe.
    // Goes from (−cx−s/2, −r) → (−cx−s/2−r, 0) → (−cx−s/2, +r).
    {
      const center = { x: -cx - halfS, z: 0 };
      const arcLen = Math.PI * r;
      stages.push({
        length: arcLen,
        at: (t) => {
          // Start angle −π/2 (straight down in our +Z=down convention),
          // sweep through −π (left side) to −3π/2 ≡ +π/2 (up).
          const angle = -Math.PI / 2 - (t / arcLen) * Math.PI;
          return {
            x: center.x + r * Math.cos(angle),
            z: center.z + r * Math.sin(angle),
          };
        },
      });
    }

    // Stage 5: left-front straight, moving +X.
    stages.push({
      length: s,
      at: (t) => ({ x: leftFrontL.x + t, z: leftFrontL.z }),
    });

    // Stage 6: NE diagonal, from (−cx+s/2, +r) to (cx−s/2, −r). UNDER-PASS.
    const diag2Len = Math.hypot(
      rightBackL.x - leftFrontR.x,
      rightBackL.z - leftFrontR.z,
    );
    stages.push({
      length: diag2Len,
      at: (t) => {
        const a = t / diag2Len;
        return {
          x: leftFrontR.x + (rightBackL.x - leftFrontR.x) * a,
          z: leftFrontR.z + (rightBackL.z - leftFrontR.z) * a,
        };
      },
    });

    // Stage 7: right-back straight, moving +X.
    stages.push({
      length: s,
      at: (t) => ({ x: rightBackL.x + t, z: rightBackL.z }),
    });

    // Stage 8: right semicircle around the far (+X) side of the right lobe.
    // From (cx+s/2, −r) → (cx+s/2+r, 0) → (cx+s/2, +r).
    {
      const center = { x: cx + halfS, z: 0 };
      const arcLen = Math.PI * r;
      stages.push({
        length: arcLen,
        at: (t) => {
          // Start angle −π/2, sweep through 0 (right side) to +π/2.
          const angle = -Math.PI / 2 + (t / arcLen) * Math.PI;
          return {
            x: center.x + r * Math.cos(angle),
            z: center.z + r * Math.sin(angle),
          };
        },
      });
    }

    return stages;
  }

  private buildCheckpoints(): void {
    // Place N checkpoints evenly spaced along the centerline. Checkpoint 0 is
    // at sample 0 (t = 0), which is (LOBE_X, 0, 0) — the right extreme, a
    // flat spot well away from the bridge apex.
    const N = 8;
    const total = this.centerline.length;
    for (let i = 0; i < N; i++) {
      const idx = Math.floor((i * total) / N);
      const p = this.centerline[idx].clone();
      const next = this.centerline[(idx + 4) % total];
      // Forward = XZ tangent only (ignore y), so checkpoint yaw is flat even
      // when the waypoint is on a ramp.
      const forward = next.clone().sub(p);
      forward.y = 0;
      forward.normalize();
      this.checkpoints.push({ index: i, position: p, forward });
    }
  }

  private buildSpawnPoints(): void {
    // Spawn 4 cars in a 2x2 grid AHEAD of the start/finish line. Start line
    // is at sample 0 (t = 0, right extreme) which is flat. Cars need to
    // complete a full lap to cross the line the first time.
    //
    // Y offset = centerline.y + 1.5 so wheels sit above ground at spawn:
    // chassis_half_y=0.4, wheel offset 0.2, suspension rest 0.5, wheel radius
    // 0.4 → wheel bottom ≈ road_y + 0.4.
    const ahead = 5; // waypoints ahead of the start line
    const anchor = this.centerline[ahead];
    const next = this.centerline[ahead + 1];
    const forward = next.clone().sub(anchor);
    forward.y = 0;
    forward.normalize();
    const left = new THREE.Vector3(-forward.z, 0, forward.x); // 90° CCW

    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const back = -row * 6;           // staggered rows: 0, 6m back
        const side = (col - 0.5) * 6;    // ±3m to the side
        this.spawnPoints.push({
          position: anchor
            .clone()
            .addScaledVector(forward, back)
            .addScaledVector(left, side)
            .add(new THREE.Vector3(0, 1.5, 0)),
          forward: forward.clone(),
        });
      }
    }
  }

  // Adds road, walls, ground, checkpoint sensors, bridge deck, scenery.
  // Mutates the scene + world.
  addToWorld(scene: THREE.Scene, world: RAPIER.World, RAPIER: RapierModule): void {
    // --- Ground plane ---
    const groundSize = 900;
    const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x3a6b2f });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const groundColliderDesc = RAPIER.ColliderDesc.cuboid(groundSize / 2, 0.1, groundSize / 2)
      .setTranslation(0, -0.1, 0)
      .setFriction(1.5);
    world.createCollider(groundColliderDesc);

    // --- Road ribbon ---
    // Strip of quads along the centerline, width = ROAD_WIDTH, lifted by
    // ROAD_Y_OFFSET above the ground. The offset must be large enough that
    // the depth-buffer can distinguish road from ground from camera distances
    // up to ~50 m. 0.01 m was too tight and caused visible z-fighting that
    // looked like the car was vibrating in place. 0.06 m clears it.
    const ROAD_Y_OFFSET = 0.06;
    const positions: number[] = [];
    const indices: number[] = [];
    const N = this.centerline.length;
    for (let i = 0; i < N; i++) {
      const p = this.centerline[i];
      const pNext = this.centerline[(i + 1) % N];
      // Horizontal tangent (XZ only) → road surface stays horizontal across
      // its width even on ramps.
      const fwdXZ = new THREE.Vector3(pNext.x - p.x, 0, pNext.z - p.z).normalize();
      const leftXZ = new THREE.Vector3(-fwdXZ.z, 0, fwdXZ.x).multiplyScalar(ROAD_WIDTH / 2);
      const rightXZ = leftXZ.clone().negate();
      positions.push(p.x + leftXZ.x, p.y + ROAD_Y_OFFSET, p.z + leftXZ.z);
      positions.push(p.x + rightXZ.x, p.y + ROAD_Y_OFFSET, p.z + rightXZ.z);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = ((i + 1) % N) * 2;
      const d = ((i + 1) % N) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    roadGeo.setIndex(indices);
    roadGeo.computeVertexNormals();
    // polygonOffset pushes the road forward in the depth buffer regardless
    // of camera distance — second line of defense against z-fighting on top
    // of the explicit Y offset above.
    const roadMat = new THREE.MeshLambertMaterial({
      color: 0x2a2a2a,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    const road = new THREE.Mesh(roadGeo, roadMat);
    scene.add(road);

    // --- Walls + bridge deck colliders ---
    this.buildWalls(scene, world, RAPIER);
    this.buildBridgeDeck(scene, world, RAPIER);

    // --- Checkpoint sensors ---
    this.buildCheckpointSensors(scene, world, RAPIER);

    // --- Scenery (trees + buildings) ---
    this.buildScenery(scene);
  }

  // Build an offset curve (one point per centerline vertex) that follows
  // the road at a perpendicular distance of `offset` meters. The perpendicular
  // at each vertex is computed from the AVERAGE of the incoming and outgoing
  // tangents — this is what makes adjacent wall segments meet without gaps
  // (outside of a curve) or overlaps (inside of a curve).
  //
  // `sign` = -1 builds the left-side curve, +1 builds the right-side curve.
  private offsetCurve(sign: number, offset: number): THREE.Vector3[] {
    const N = this.centerline.length;
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      const prev = this.centerline[(i - 1 + N) % N];
      const curr = this.centerline[i];
      const next = this.centerline[(i + 1) % N];
      // Tangents around the vertex, flattened onto XZ so the perpendicular
      // stays horizontal.
      const tIn = new THREE.Vector3(curr.x - prev.x, 0, curr.z - prev.z);
      const tOut = new THREE.Vector3(next.x - curr.x, 0, next.z - curr.z);
      if (tIn.lengthSq() > 1e-8) tIn.normalize();
      if (tOut.lengthSq() > 1e-8) tOut.normalize();
      const avg = tIn.add(tOut);
      if (avg.lengthSq() < 1e-8) avg.set(tOut.x || 1, 0, tOut.z);
      avg.normalize();
      // Right-of-forward in XZ: (fwd.z, 0, -fwd.x).
      // sign = +1 → offset to the right, sign = -1 → offset to the left.
      const perp = new THREE.Vector3(avg.z, 0, -avg.x).multiplyScalar(sign * offset);
      out.push(curr.clone().add(perp));
    }
    return out;
  }

  // Walls are built from two offset curves (one per side). A cuboid runs
  // between consecutive offset points, so wall segments exactly match the
  // shape of the wall-side path — no gaps on the outside of a curve, no
  // overlaps on the inside. The cuboid's "length" axis follows the 3D
  // segment direction so the wall pitches up onto the bridge ramp.
  private buildWalls(
    scene: THREE.Scene,
    world: RAPIER.World,
    RAPIER: RapierModule,
  ): void {
    const N = this.centerline.length;
    const offset = ROAD_WIDTH / 2 + WALL_THICKNESS / 2;
    for (const sign of [-1, 1]) {
      const curve = this.offsetCurve(sign, offset);
      const color = sign < 0 ? 0xff5050 : 0xfafafa;
      const wallMat = new THREE.MeshLambertMaterial({ color });
      for (let i = 0; i < N; i++) {
        const a = curve[i];
        const b = curve[(i + 1) % N];
        const seg = b.clone().sub(a);
        const segLen = seg.length();
        if (segLen < 1e-4) continue;
        const fwd3 = seg.clone().normalize();
        // Horizontal right in the XZ plane, perpendicular to fwd.
        const rightXZ = new THREE.Vector3(fwd3.z, 0, -fwd3.x);
        if (rightXZ.lengthSq() < 1e-6) continue;
        rightXZ.normalize();
        // Wall "up" = forward × right (right-handed basis). Tilts with the
        // ramp so the top tracks the road slope.
        const upVec = new THREE.Vector3().crossVectors(fwd3, rightXZ).normalize();

        const m = new THREE.Matrix4().makeBasis(rightXZ, upVec, fwd3);
        const quat = new THREE.Quaternion().setFromRotationMatrix(m);

        const center = a
          .clone()
          .addScaledVector(seg, 0.5)
          .addScaledVector(upVec, WALL_HEIGHT / 2);

        const wallGeo = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, segLen);
        const wallMesh = new THREE.Mesh(wallGeo, wallMat);
        wallMesh.position.copy(center);
        wallMesh.quaternion.copy(quat);
        scene.add(wallMesh);

        const desc = RAPIER.ColliderDesc.cuboid(
          WALL_THICKNESS / 2,
          WALL_HEIGHT / 2,
          segLen / 2,
        )
          .setTranslation(center.x, center.y, center.z)
          .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
          .setFriction(0.4)
          // Restitution 0 so cars don't trampoline off walls. Combined
          // with chassis restitution 0, contact bounce is zero — the car
          // scrapes along the wall instead of vibrating against it.
          .setRestitution(0.0);
        world.createCollider(desc);
      }
    }
  }

  // Bridge deck — one thin cuboid collider + matching visual per segment
  // where the road rises noticeably above ground. Visible as a lighter gray
  // underside so the bridge reads clearly from across the map.
  private buildBridgeDeck(
    scene: THREE.Scene,
    world: RAPIER.World,
    RAPIER: RapierModule,
  ): void {
    const N = this.centerline.length;
    for (let i = 0; i < N; i++) {
      const p = this.centerline[i];
      const pNext = this.centerline[(i + 1) % N];
      if (p.y < DECK_MIN_Y && pNext.y < DECK_MIN_Y) continue;
      const seg = pNext.clone().sub(p);
      const segLen = seg.length();
      if (segLen < 0.001) continue;
      const fwd3 = seg.clone().normalize();
      const rightXZ = new THREE.Vector3(fwd3.z, 0, -fwd3.x);
      if (rightXZ.lengthSq() < 1e-6) continue;
      rightXZ.normalize();
      const upVec = new THREE.Vector3().crossVectors(fwd3, rightXZ).normalize();

      const m = new THREE.Matrix4().makeBasis(rightXZ, upVec, fwd3);
      const quat = new THREE.Quaternion().setFromRotationMatrix(m);

      // Deck center is at (segment midpoint) − DECK_THICKNESS/2 along upVec,
      // so the top face lines up with the road surface.
      const center = p
        .clone()
        .add(seg.clone().multiplyScalar(0.5))
        .addScaledVector(upVec, -DECK_THICKNESS / 2);

      // Visual deck (slightly wider than the road so it sticks out past the
      // walls).
      const deckGeo = new THREE.BoxGeometry(ROAD_WIDTH + 1.0, DECK_THICKNESS, segLen + 0.05);
      const deckMat = new THREE.MeshLambertMaterial({ color: 0x555a60 });
      const deckMesh = new THREE.Mesh(deckGeo, deckMat);
      deckMesh.position.copy(center);
      deckMesh.quaternion.copy(quat);
      scene.add(deckMesh);

      // Collider (road-width only — pedestrians shouldn't fall off the visual
      // overhang in physics).
      const desc = RAPIER.ColliderDesc.cuboid(
        ROAD_WIDTH / 2,
        DECK_THICKNESS / 2,
        segLen / 2 + 0.025,
      )
        .setTranslation(center.x, center.y, center.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
        .setFriction(1.5);
      world.createCollider(desc);
    }
  }

  // Per-checkpoint axis-aligned sensor box. Centered 2.5 m above the road
  // surface so it stays above wheel raycast origins (see original comment:
  // a wheel ray starting inside a collider returns toi=0 and breaks the
  // suspension). Works on the bridge too — we just offset from cp.position.y.
  private buildCheckpointSensors(
    scene: THREE.Scene,
    world: RAPIER.World,
    RAPIER: RapierModule,
  ): void {
    for (const cp of this.checkpoints) {
      const yaw = Math.atan2(cp.forward.x, cp.forward.z);
      const desc = RAPIER.ColliderDesc.cuboid(ROAD_WIDTH / 2, 1.5, 0.6)
        .setTranslation(cp.position.x, cp.position.y + 2.5, cp.position.z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setSensor(true);
      const sensor = world.createCollider(desc);
      this.checkpointHandles.set(sensor.handle, cp.index);

      // Debug visual: thin colored line for the start/finish.
      if (cp.index === 0) {
        const lineGeo = new THREE.BoxGeometry(ROAD_WIDTH, 0.05, 0.6);
        const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const lineMesh = new THREE.Mesh(lineGeo, lineMat);
        lineMesh.position.set(cp.position.x, cp.position.y + 0.03, cp.position.z);
        lineMesh.rotation.y = yaw;
        scene.add(lineMesh);
      }
    }
  }

  // Hand-placed scenery. All visual-only (no colliders) so the physics world
  // stays light. Positions are chosen to sit outside the track's XZ bounding
  // box plus a small buffer.
  private buildScenery(scene: THREE.Scene): void {
    // --- Trees ---
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
    const foliageMats = [
      new THREE.MeshLambertMaterial({ color: 0x2e7d32 }),
      new THREE.MeshLambertMaterial({ color: 0x3f8f3a }),
      new THREE.MeshLambertMaterial({ color: 0x1f5e28 }),
    ];
    const treePositions: Array<[number, number, number]> = [
      // Outer ring of trees, beyond the extremes of the figure-8 lobes.
      [-230, 0, 60], [-240, 0, -50], [-205, 0, 150], [-215, 0, -170],
      [230, 0, -60], [240, 0, 50], [205, 0, -150], [215, 0, 170],
      [-85, 0, 220], [85, 0, 220], [-85, 0, -220], [85, 0, -220],
      [0, 0, 240], [0, 0, -240], [-270, 0, 0], [270, 0, 0],
      [-160, 0, 200], [160, 0, 200], [-160, 0, -200], [160, 0, -200],
      [-260, 0, 120], [260, 0, -120], [-260, 0, -120], [260, 0, 120],
      [-180, 0, 250], [180, 0, -250], [-180, 0, -250], [180, 0, 250],
    ];
    let variantIdx = 0;
    for (const [x, , z] of treePositions) {
      const group = new THREE.Group();
      const trunkHeight = 2 + (Math.abs((x * 13 + z * 7) % 1.5));
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.5, trunkHeight, 8),
        trunkMat,
      );
      trunk.position.y = trunkHeight / 2;
      group.add(trunk);
      const foliageMat = foliageMats[variantIdx++ % foliageMats.length];
      const foliageRadius = 1.8 + (Math.abs((x * 3 + z) % 1));
      const foliage = new THREE.Mesh(
        new THREE.ConeGeometry(foliageRadius, foliageRadius * 2.2, 10),
        foliageMat,
      );
      foliage.position.y = trunkHeight + foliageRadius * 0.9;
      group.add(foliage);
      group.position.set(x, 0, z);
      scene.add(group);
    }

    // --- Buildings ---
    // Small cluster of low boxes with flat roofs. Positioned far from the
    // track so they read as "distant city".
    type Building = {
      pos: [number, number]; size: [number, number, number]; color: number; roof: number;
    };
    const buildings: Building[] = [
      { pos: [-320, -280], size: [26, 36, 22], color: 0xb0875a, roof: 0x664033 },
      { pos: [-360, -240], size: [18, 24, 18], color: 0xd8c0a0, roof: 0x3f3a36 },
      { pos: [-280, -330], size: [32, 18, 20], color: 0x8a9bb0, roof: 0x2e2e2e },
      { pos: [330, 280], size: [30, 46, 28], color: 0xcd6e5f, roof: 0x3f3a36 },
      { pos: [370, 230], size: [22, 30, 22], color: 0xe0d1a0, roof: 0x544132 },
      { pos: [280, 340], size: [34, 22, 24], color: 0x6fa0bf, roof: 0x2e2e2e },
      { pos: [330, -290], size: [24, 32, 24], color: 0xa8a8a8, roof: 0x3a3a3a },
      { pos: [-290, 330], size: [28, 28, 34], color: 0x9fb09a, roof: 0x3a3a3a },
      { pos: [-370, 300], size: [22, 42, 22], color: 0xc8a07a, roof: 0x3a2e26 },
      { pos: [360, -350], size: [20, 38, 20], color: 0x7a8f9e, roof: 0x2a2a2a },
    ];
    for (const b of buildings) {
      const [w, h, d] = b.size;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshLambertMaterial({ color: b.color }),
      );
      body.position.set(b.pos[0], h / 2, b.pos[1]);
      scene.add(body);
      // Flat cap / parapet to break up the silhouette.
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(w + 1, 0.6, d + 1),
        new THREE.MeshLambertMaterial({ color: b.roof }),
      );
      cap.position.set(b.pos[0], h + 0.3, b.pos[1]);
      scene.add(cap);
    }
  }

  // Returns the centerline waypoint closest to a given 3D position. Used by
  // AI. 3D distance (including y) is important so the bridge pass and the
  // under-pass are disambiguated at the crossing.
  closestWaypointIndex(pos: THREE.Vector3): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.centerline.length; i++) {
      const d = this.centerline[i].distanceToSquared(pos);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
}
