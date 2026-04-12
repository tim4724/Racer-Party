// SplitScreen — viewport layout + per-car chase camera + per-frame render.
//
// Layout algorithm: pick (rows, cols) such that rows*cols ≥ N and the
// resulting tile aspect ratio is closest to the display aspect ratio. For
// 16:9 + N=1..4 this gives 1×1, 1×2, 2×2, 2×2.

import * as THREE from 'three';
import type { Car } from './Car';

const CAMERA_DISTANCE = 8;
const CAMERA_HEIGHT = 4;
const CAMERA_LERP = 0.12;
const FOV_DEG = 70;

export interface ViewportLayout {
  x: number; y: number; w: number; h: number;
}

// Pure function — exported for unit tests.
export function computeLayout(n: number, totalWidth: number, totalHeight: number): ViewportLayout[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0, w: totalWidth, h: totalHeight }];

  const targetAspect = totalWidth / totalHeight;
  let bestRows = 1;
  let bestCols = n;
  let bestScore = Infinity;
  for (let rows = 1; rows <= n; rows++) {
    const cols = Math.ceil(n / rows);
    if (rows * cols < n) continue;
    const tileAspect = (totalWidth / cols) / (totalHeight / rows);
    const score = Math.abs(Math.log(tileAspect / targetAspect));
    // Prefer exact fits.
    const exactBonus = rows * cols === n ? -0.05 : 0;
    // On landscape displays, prefer fewer rows (wider tiles).
    // On portrait displays, prefer fewer columns (taller tiles).
    const orientationBonus =
      targetAspect >= 1 ? rows * 0.001 : cols * 0.001;
    const total = score + exactBonus + orientationBonus;
    if (total < bestScore) {
      bestScore = total;
      bestRows = rows;
      bestCols = cols;
    }
  }

  const tileW = totalWidth / bestCols;
  const tileH = totalHeight / bestRows;
  const out: ViewportLayout[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / bestCols);
    const col = i % bestCols;
    out.push({
      x: Math.round(col * tileW),
      // WebGL viewport y is from the bottom; flip rows.
      y: Math.round((bestRows - row - 1) * tileH),
      w: Math.round(tileW),
      h: Math.round(tileH),
    });
  }
  return out;
}

export class SplitScreen {
  canvas: HTMLCanvasElement;
  hudLayer: HTMLElement;
  renderer: THREE.WebGLRenderer;
  cars: Car[];           // human cars only — one viewport per
  cameras: THREE.PerspectiveCamera[] = [];
  // Smoothed camera state, kept outside the THREE camera to avoid jitter.
  private camState: { pos: THREE.Vector3; look: THREE.Vector3; initialized: boolean }[] = [];
  viewports: ViewportLayout[] = [];

  private readonly onWindowResize = (): void => this.handleResize();

  constructor(canvas: HTMLCanvasElement, hudLayer: HTMLElement, renderer: THREE.WebGLRenderer, humanCars: Car[]) {
    this.canvas = canvas;
    this.hudLayer = hudLayer;
    this.renderer = renderer;
    this.cars = humanCars.length > 0 ? humanCars : [];
    for (const _car of this.cars) {
      const cam = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 800);
      this.cameras.push(cam);
      this.camState.push({ pos: new THREE.Vector3(), look: new THREE.Vector3(), initialized: false });
    }
    if (this.cars.length === 0) {
      // Fallback: one spectator camera. Used in debug mode without humans.
      const cam = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 800);
      cam.position.set(0, 60, 80);
      cam.lookAt(0, 0, 0);
      this.cameras.push(cam);
    }
    // React to window resize so the renderer, viewport rects, and camera
    // aspect ratios all stay in sync. RaceSim resizes the canvas; we update
    // the rest.
    window.addEventListener('resize', this.onWindowResize);
  }

  // Resync renderer + viewports + camera aspects with the current canvas size.
  // Safe to call repeatedly. Called both from the resize listener and
  // implicitly on the first render.
  handleResize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.recalcLayout();
  }

  recalcLayout(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.viewports = computeLayout(this.cameras.length, w, h);
    for (let i = 0; i < this.cameras.length; i++) {
      const v = this.viewports[i];
      this.cameras[i].aspect = v.w / v.h;
      this.cameras[i].updateProjectionMatrix();
    }
  }

  render(scene: THREE.Scene): void {
    if (this.viewports.length !== this.cameras.length) this.recalcLayout();
    const gl = this.renderer;

    // Update follow cameras for human cars.
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const cam = this.cameras[i];
      const carPos = new THREE.Vector3().copy(car.mesh.position);
      const fwd = car.forward();
      const desiredPos = carPos
        .clone()
        .addScaledVector(fwd, -CAMERA_DISTANCE)
        .add(new THREE.Vector3(0, CAMERA_HEIGHT, 0));
      const desiredLook = carPos.clone().addScaledVector(fwd, 5).add(new THREE.Vector3(0, 1, 0));

      const cs = this.camState[i];
      if (!cs.initialized) {
        // First frame: snap so we don't lerp from the world origin.
        cs.pos.copy(desiredPos);
        cs.look.copy(desiredLook);
        cs.initialized = true;
      } else {
        cs.pos.lerp(desiredPos, CAMERA_LERP);
        cs.look.lerp(desiredLook, CAMERA_LERP);
      }
      cam.position.copy(cs.pos);
      cam.lookAt(cs.look);
    }

    gl.setScissorTest(true);
    for (let i = 0; i < this.cameras.length; i++) {
      const v = this.viewports[i];
      gl.setViewport(v.x, v.y, v.w, v.h);
      gl.setScissor(v.x, v.y, v.w, v.h);
      gl.render(scene, this.cameras[i]);
    }
    gl.setScissorTest(false);
  }

  // CSS coordinates (top-left origin, in clientWidth/Height units) for HUD.
  cssLayouts(): ViewportLayout[] {
    const h = this.canvas.clientHeight || window.innerHeight;
    return this.viewports.map((v) => ({
      x: v.x,
      y: h - v.y - v.h,
      w: v.w,
      h: v.h,
    }));
  }

  dispose(): void {
    window.removeEventListener('resize', this.onWindowResize);
  }
}
