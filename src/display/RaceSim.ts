// RaceSim — owns the Rapier world, all cars, the track, and the fixed-step
// simulation loop. The display is authoritative; everything else is a view.
//
// Lifecycle:
//   sim = new RaceSim({...})
//   await sim.init()             // loads Rapier, builds world + cars
//   sim.startRenderLoop(onFrame) // begins requestAnimationFrame
//   sim.startRace()              // unfreezes inputs and starts the lap clock
//   sim.dispose()                // tears everything down

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Track } from './Track';
import { Car } from './Car';
import { AiDriver } from './AiDriver';
import type { InputState, RaceEndStanding } from '@shared/protocol';
import type { Player } from './DisplayConnection';

const FIXED_STEP = 1 / 60;
const MAX_FRAME_DT = 0.1;

export interface RaceSimOptions {
  // The canvas to render into. May be null in tests; renderer init is skipped.
  canvas: HTMLCanvasElement | null;
  humans: Player[];
  aiCount: number;
  totalLaps: number;
  onLapCompleted: (carId: number, lap: number) => void;
  onRaceFinished: (standings: RaceEndStanding[]) => void;
}

export class RaceSim {
  readonly canvas: HTMLCanvasElement | null;
  readonly humans: Player[];
  readonly aiCount: number;
  readonly totalLaps: number;
  readonly onLapCompleted: (carId: number, lap: number) => void;
  readonly onRaceFinished: (standings: RaceEndStanding[]) => void;

  scene = new THREE.Scene();
  // Renderer is null in headless tests; the browser path always sets it.
  renderer: THREE.WebGLRenderer = null as unknown as THREE.WebGLRenderer;
  world!: RAPIER.World;
  eventQueue!: RAPIER.EventQueue;
  track!: Track;
  cars: Car[] = [];
  aiDrivers = new Map<number, AiDriver>(); // carId → AI

  // Map<clientId, carId> for routing INPUT messages.
  private clientToCarId = new Map<string, number>();

  private accumulator = 0;
  private lastTime = 0;
  private rafHandle: number | null = null;
  private running = false;
  private paused = false;
  private pausedAt = 0;
  private raceStarted = false;
  private raceEnded = false;
  private raceStartTime = 0;
  private finishedCount = 0;
  private rapierReady = false;

  constructor(options: RaceSimOptions) {
    this.canvas = options.canvas;
    this.humans = options.humans;
    this.aiCount = options.aiCount;
    this.totalLaps = options.totalLaps;
    this.onLapCompleted = options.onLapCompleted;
    this.onRaceFinished = options.onRaceFinished;
  }

  async init(): Promise<void> {
    await RAPIER.init();
    this.rapierReady = true;

    // --- Renderer (browser only) ---
    if (this.canvas) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      this.renderer.setPixelRatio(window.devicePixelRatio || 1);
      this.resizeRenderer();
      window.addEventListener('resize', this.resizeRenderer);
    }

    // --- Scene ---
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.Fog(0x87ceeb, 200, 800);

    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(50, 100, 30);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    // --- Physics ---
    const gravity = { x: 0, y: -9.81 * 2, z: 0 };
    this.world = new RAPIER.World(gravity);
    this.eventQueue = new RAPIER.EventQueue(true);

    // --- Track ---
    this.track = new Track();
    this.track.addToWorld(this.scene, this.world, RAPIER);

    // --- Cars ---
    this.spawnCars();
  }

  // Test hook: run a single fixed-step physics tick. Tests use this to drive
  // the sim deterministically without `requestAnimationFrame`.
  tickOnce(dt = FIXED_STEP): void {
    this.tick(dt);
  }

  private spawnCars(): void {
    const totalCars = this.humans.length + this.aiCount;
    for (let i = 0; i < totalCars; i++) {
      const isAI = i >= this.humans.length;
      const human = isAI ? null : this.humans[i];
      const carId = i;
      const spawn = this.track.spawnPoints[i] ?? this.track.spawnPoints[0];

      const car = new Car({
        carId,
        name: human ? human.name : `CPU ${i + 1}`,
        color: human ? human.color : ['#ffffff', '#aaaaaa', '#666666', '#444444'][i] || '#888888',
        isAI,
        spawn,
      });
      car.buildPhysics(this.world, RAPIER, spawn);
      this.scene.add(car.mesh);
      this.cars.push(car);
      if (isAI) {
        this.aiDrivers.set(carId, new AiDriver(car, this.track));
      } else if (human) {
        this.clientToCarId.set(human.id, carId);
      }
    }
  }

  applyHumanInput(clientId: string, input: InputState): void {
    const carId = this.clientToCarId.get(clientId);
    if (carId === undefined) return;
    const car = this.cars[carId];
    if (car) car.applyInput(input);
  }

  // Promote an AI car to a human-driven slot. Used by the keyboard debug
  // path: with `?debug=1` and no real phones connected, the first AI car is
  // taken over by the keyboard. Removes the AI driver so it can no longer
  // overwrite the car's input on each tick.
  takeOverAiCar(carId: number): Car | null {
    const car = this.cars[carId];
    if (!car) return null;
    car.isAI = false;
    this.aiDrivers.delete(carId);
    return car;
  }

  startRace(): void {
    this.raceStarted = true;
    this.raceEnded = false;
    this.finishedCount = 0;
    this.raceStartTime = performance.now();
    for (const car of this.cars) {
      car.currentLapStartTime = this.raceStartTime;
      car.lap = 0;
      car.lastCheckpointIndex = -1;
      car.visitedThisLap.clear();
      // Clear any input set during the countdown freeze. Without this, a
      // human car whose phone hasn't sent an INPUT yet stays braked at 100%
      // forever — auto-throttle never engages because brake > 0.
      car.applyInput({ steer: 0, brake: 0 });
    }
  }

  startRenderLoop(onFrame: (dt: number) => void): void {
    this.running = true;
    this.lastTime = performance.now();
    const tick = () => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(tick);
      const now = performance.now();
      let dt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
      // While paused, the renderer keeps drawing the frozen frame and HUD
      // updates run, but physics + lap timing are suspended.
      if (!this.paused) {
        this.stepFixed(dt);
        this.syncMeshes();
      }
      onFrame(dt);
    };
    tick();
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pausedAt = performance.now();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // Shift the race clock forward so paused time doesn't count toward lap totals.
    const delta = performance.now() - this.pausedAt;
    if (this.raceStarted) {
      this.raceStartTime += delta;
      for (const car of this.cars) car.currentLapStartTime += delta;
    }
    // Reset frame timing so the next dt isn't a giant leap.
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  private stepFixed(frameDt: number): void {
    this.accumulator += frameDt;
    while (this.accumulator >= FIXED_STEP) {
      this.accumulator -= FIXED_STEP;
      for (const car of this.cars) car.savePrevState();
      this.tick(FIXED_STEP);
    }
  }

  private tick(dt: number): void {
    // 1. AI inputs
    if (this.raceStarted) {
      for (const [carId, ai] of this.aiDrivers) {
        this.cars[carId].applyInput(ai.computeInput());
      }
    }
    // 2. Apply car physics
    for (const car of this.cars) {
      if (this.raceStarted) {
        car.step(dt);
      } else {
        // Frozen during countdown — sit still without engaging reverse.
        car.stepFrozen(dt);
      }
    }
    // 3. Step Rapier
    this.world.step(this.eventQueue);

    // 3a. Post-step drift speed preservation (must run after world.step).
    for (const car of this.cars) car.postStep();

    // 3b. Out-of-bounds recovery — respawn at nearest centerline waypoint
    if (this.raceStarted) this.checkOutOfBounds();

    // 4. Process collision events for checkpoint sensors
    if (this.raceStarted) {
      this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
        if (!started) return;
        let cpIdx = this.track.checkpointHandles.get(handle1);
        let otherHandle = handle2;
        if (cpIdx === undefined) {
          cpIdx = this.track.checkpointHandles.get(handle2);
          otherHandle = handle1;
        }
        if (cpIdx === undefined) return;
        // Find which car owns otherHandle
        for (const car of this.cars) {
          if (car.collider.handle === otherHandle) {
            this.handleCheckpointHit(car, cpIdx);
            return;
          }
        }
      });
    }
  }

  private handleCheckpointHit(car: Car, cpIdx: number): void {
    if (car.finished) return;
    const expected = (car.lastCheckpointIndex + 1) % this.track.checkpoints.length;
    if (cpIdx !== expected) return; // out of order — ignored

    car.lastCheckpointIndex = cpIdx;
    car.visitedThisLap.add(cpIdx);

    if (cpIdx === 0 && car.visitedThisLap.size >= this.track.checkpoints.length) {
      // Lap completed.
      car.lap += 1;
      car.visitedThisLap.clear();
      car.visitedThisLap.add(0);
      car.currentLapStartTime = performance.now();
      this.onLapCompleted(car.carId, car.lap);
      if (car.lap >= this.totalLaps) {
        car.finished = true;
        car.totalTime = performance.now() - this.raceStartTime;
        this.finishedCount += 1;
        car.placement = this.finishedCount;
        this.maybeEndRace();
      }
    } else if (cpIdx === 0 && car.lap === 0) {
      // First time crossing the line at race start — counts as starting lap 1.
      car.lap = 1;
      car.visitedThisLap.clear();
      car.visitedThisLap.add(0);
      car.currentLapStartTime = performance.now();
      this.onLapCompleted(car.carId, car.lap);
    }
  }

  // Decide whether the race should end now. Rule:
  //   - 1 human total → end as soon as that human finishes.
  //   - N>1 humans   → end as soon as N-1 humans have finished (don't make
  //                    everyone wait on the trailing player).
  //   - 0 humans     → wait until every car finishes (debug / AI-only).
  // The remaining cars are force-finished so they appear in the standings
  // with totalTime = 0 (rendered as "—").
  private maybeEndRace(): void {
    if (this.raceEnded) return;
    const humans = this.cars.filter((c) => !c.isAI);
    if (humans.length === 0) {
      if (this.finishedCount >= this.cars.length) this.endRaceNow();
      return;
    }
    const humansFinished = humans.filter((c) => c.finished).length;
    const threshold = Math.max(1, humans.length - 1);
    if (humansFinished >= threshold) this.endRaceNow();
  }

  private endRaceNow(): void {
    if (this.raceEnded) return;
    this.raceEnded = true;
    // Mark every still-racing car as finished without bumping placement past
    // the actual finishers — they get totalTime = 0 (renders as "—").
    for (const car of this.cars) {
      if (!car.finished) {
        car.finished = true;
        car.totalTime = 0;
        car.placement = 0;
      }
    }
    this.emitRaceFinished();
  }

  // If a car falls below the world or strays too far from the track
  // centerline, teleport it back to the nearest waypoint. The road is 24 m
  // wide; anything beyond ~40 m from centerline is clearly off-track.
  private static readonly OOB_DIST_SQ = 40 * 40;
  private static readonly OOB_MIN_Y = -5;

  private checkOutOfBounds(): void {
    for (const car of this.cars) {
      if (car.finished) continue;
      const t = car.body.translation();
      const belowWorld = t.y < RaceSim.OOB_MIN_Y;

      let tooFar = false;
      if (!belowWorld) {
        const pos = new THREE.Vector3(t.x, t.y, t.z);
        const wpIdx = this.track.closestWaypointIndex(pos);
        const wp = this.track.centerline[wpIdx];
        const dx = t.x - wp.x;
        const dz = t.z - wp.z;
        tooFar = dx * dx + dz * dz > RaceSim.OOB_DIST_SQ;
      }

      if (belowWorld || tooFar) {
        const pos = new THREE.Vector3(t.x, t.y, t.z);
        const wpIdx = this.track.closestWaypointIndex(pos);
        const wp = this.track.centerline[wpIdx];
        const nextWp = this.track.centerline[(wpIdx + 1) % this.track.centerline.length];
        const fwd = nextWp.clone().sub(wp);
        fwd.y = 0;
        fwd.normalize();
        car.respawnAt(wp, fwd);
      }
    }
  }

  private emitRaceFinished(): void {
    // A car with finished + totalTime > 0 actually crossed the line.
    // A car with finished + totalTime === 0 was force-finished by the early-
    // end rule (treated as DNF, placed after real finishers by lap/progress).
    const completed = (c: Car) => c.finished && c.totalTime > 0;
    const standings: RaceEndStanding[] = this.cars
      .slice()
      .sort((a, b) => {
        if (completed(a) && !completed(b)) return -1;
        if (!completed(a) && completed(b)) return 1;
        if (completed(a) && completed(b)) return a.totalTime - b.totalTime;
        // Both DNF — order by lap, then checkpoint progress.
        if (a.lap !== b.lap) return b.lap - a.lap;
        return b.lastCheckpointIndex - a.lastCheckpointIndex;
      })
      .map((c, i) => ({
        carId: c.carId,
        name: c.name,
        placement: i + 1,
        totalTime: completed(c) ? c.totalTime : 0,
      }));
    this.onRaceFinished(standings);
  }

  private syncMeshes(): void {
    // Interpolation factor: how far into the NEXT physics step are we?
    // 0 = right at the last completed step, 1 = about to start the next.
    const alpha = this.accumulator / FIXED_STEP;
    for (const car of this.cars) car.syncMesh(alpha);
  }

  private resizeRenderer = (): void => {
    if (!this.canvas || !this.renderer) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
  };

  dispose(): void {
    this.running = false;
    if (this.rafHandle != null) cancelAnimationFrame(this.rafHandle);
    if (this.canvas) window.removeEventListener('resize', this.resizeRenderer);
    if (this.rapierReady) {
      try {
        this.world.free();
      } catch {
        // ignore
      }
    }
    if (this.renderer) this.renderer.dispose();
    // Free Three.js geometries.
    this.scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.geometry) m.geometry.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose?.());
      else if (mat) mat.dispose?.();
    });
  }
}
