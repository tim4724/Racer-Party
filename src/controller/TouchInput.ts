// TouchInput — pointer-event drag → continuous `steer` for the controller
// side. Brake is handled by the dedicated BRAKE button (see ControllerGame),
// so this source only produces steer. The consumer wires `onChange` to the
// network layer.
//
// Drag model:
//   - Touchdown anchors at the finger position.
//   - Horizontal distance from the anchor ramps steer 0 → ±1 over
//     [DEAD_ZONE, maxDrag] px.
//   - Vertical drag is ignored.
//   - Lift the finger to reset; the next touch picks a fresh anchor.
//
// Tested in tests/touchinput.test.ts via the pure helpers `detectMode`
// and `dragToInput`.

import { clamp, type InputState } from '@shared/protocol';
import {
  sensitivityToTouchRange,
  SENSITIVITY_DEFAULT,
  type InputSource,
  type InputSourceCallbacks,
} from './inputs';

export const DEAD_ZONE = 20;  // horizontal dead zone before steer starts
// Default max steer distance (only used by `effectiveMaxDrag` / legacy tests).
export const MAX_DRAG = 120;
// Kept for test compatibility with `detectMode` / `dragToInput`.
export const BRAKE_DEAD_ZONE = 50;

export type GestureMode = 'idle' | 'steer' | 'brake';

// Compute the effective max steer drag for a touchpad of the given width.
// min(MAX_DRAG, 0.45 × width) — capped so full lock is always within
// thumb reach regardless of screen size; only shrinks below MAX_DRAG on
// very small touchpads (≤ 311 px wide).
export function effectiveMaxDrag(touchpadWidthPx: number): number {
  return Math.min(MAX_DRAG, touchpadWidthPx * 0.45);
}

// Legacy pure helper. The live source no longer uses it; we keep it (and
// `dragToInput`) so tests/touchinput.test.ts keeps working.
export function detectMode(current: GestureMode, dx: number, dy: number): GestureMode {
  if (current !== 'idle') return current;
  if (dy > BRAKE_DEAD_ZONE) return 'brake';
  if (Math.abs(dx) > DEAD_ZONE) return 'steer';
  return 'idle';
}

// Legacy pure helper used by tests. Returns `{ steer, brake }` where brake
// may be non-zero only when the gesture was in brake mode — the live
// TouchInput class no longer emits brake.
export function dragToInput(
  dx: number,
  dy: number,
  mode: GestureMode,
  maxDrag: number = MAX_DRAG,
): InputState {
  if (mode === 'idle') return { steer: 0, brake: 0 };

  const absX = Math.abs(dx);

  if (mode === 'steer') {
    const sign = dx < 0 ? -1 : (dx > 0 ? 1 : 0);
    const mag = absX <= DEAD_ZONE
      ? 0
      : clamp((absX - DEAD_ZONE) / Math.max(1, maxDrag - DEAD_ZONE), 0, 1);
    return { steer: sign * mag, brake: 0 };
  }

  // mode === 'brake': both axes active so tests can exercise reverse + steer.
  let steer = 0;
  if (absX > DEAD_ZONE) {
    const sign = dx < 0 ? -1 : 1;
    steer = sign * clamp((absX - DEAD_ZONE) / Math.max(1, maxDrag - DEAD_ZONE), 0, 1);
  }
  let brake = 0;
  if (dy > BRAKE_DEAD_ZONE) {
    brake = clamp((dy - BRAKE_DEAD_ZONE) / Math.max(1, maxDrag - BRAKE_DEAD_ZONE), 0, 1);
  }
  return { steer, brake };
}

export type TouchInputCallbacks = InputSourceCallbacks;

export class TouchInput implements InputSource {
  el: HTMLElement;
  callbacks: TouchInputCallbacks;
  activePointerId: number | null = null;
  anchorX = 0;
  anchorY = 0;
  // Effective max drag for the current sensitivity + pad width.
  private maxDrag: number = MAX_DRAG;
  // Steer-lock state: once the finger leaves the dead zone, we stick with
  // steer for the rest of the gesture (so it can't later switch mode).
  private steerLocked = false;
  lastEmitted: InputState = { steer: 0, brake: 0 };
  private sensitivity: number = SENSITIVITY_DEFAULT;

  // Drag-debug overlay (optional). Anchored to the touchdown point and
  // updated on every move so the player can see the max-drag range.
  private debugEl: SVGElement | null = null;
  private debugFinger: SVGCircleElement | null = null;

  private boundDown = (e: PointerEvent) => this.onPointerDown(e);
  private boundMove = (e: PointerEvent) => this.onPointerMove(e);
  private boundUp = (e: PointerEvent) => this.onPointerUp(e);
  private boundCancel = (e: PointerEvent) => this.onPointerUp(e);
  private boundContext = (e: Event) => e.preventDefault();

  constructor(
    el: HTMLElement,
    callbacks: TouchInputCallbacks,
    sensitivity: number = SENSITIVITY_DEFAULT,
  ) {
    this.el = el;
    this.callbacks = callbacks;
    this.sensitivity = sensitivity;
    this.el.style.touchAction = 'none';

    this.el.addEventListener('pointerdown', this.boundDown);
    this.el.addEventListener('pointermove', this.boundMove);
    this.el.addEventListener('pointerup', this.boundUp);
    this.el.addEventListener('pointercancel', this.boundCancel);
    this.el.addEventListener('contextmenu', this.boundContext);

    this.debugEl = document.getElementById('touch-debug') as SVGElement | null;
    this.debugFinger = document.getElementById('td-finger') as unknown as SVGCircleElement | null;

    this.maxDrag = this.computeMaxDrag();
    this.renderRangeIndicator();
  }

  private computeMaxDrag(): number {
    return sensitivityToTouchRange(this.sensitivity, this.el.clientWidth);
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (this.activePointerId !== null) return;
    e.preventDefault();
    this.activePointerId = e.pointerId;
    this.el.setPointerCapture(e.pointerId);
    this.anchorX = e.clientX;
    this.anchorY = e.clientY;
    this.maxDrag = this.computeMaxDrag();
    this.steerLocked = false;
    this.showDebugAtAnchor(e.clientX, e.clientY);
    this.emit({ steer: 0, brake: 0 });
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== this.activePointerId) return;
    const dx = e.clientX - this.anchorX;
    const dy = e.clientY - this.anchorY;

    if (!this.steerLocked && Math.abs(dx) > DEAD_ZONE) this.steerLocked = true;

    const absX = Math.abs(dx);
    const steerMag = this.steerLocked && absX > DEAD_ZONE
      ? clamp((absX - DEAD_ZONE) / Math.max(1, this.maxDrag - DEAD_ZONE), 0, 1)
      : 0;
    const steer = (dx < 0 ? -1 : dx > 0 ? 1 : 0) * steerMag;

    this.updateDebugFinger(dx, dy);
    this.emit({ steer, brake: 0 });
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    this.steerLocked = false;
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    this.hideDebug();
    this.emit({ steer: 0, brake: 0 });
  }

  // ---- InputSource interface ----

  setBrakeButtonPressed(_pressed: boolean): void {
    // Reserved hook — the source currently doesn't react to brake state.
  }

  setSensitivity(value: number): void {
    this.sensitivity = value;
    this.maxDrag = this.computeMaxDrag();
    this.renderRangeIndicator();
  }

  // Paint the persistent range indicator inside the pad — two vertical ticks
  // at ±maxDrag from the pad's center, labelled with the pixel distance.
  private renderRangeIndicator(): void {
    const indicator = document.getElementById('range-indicator');
    if (!indicator) return;
    indicator.classList.remove('hidden');
    const left = indicator.querySelector<HTMLElement>('.range-tick--left');
    const right = indicator.querySelector<HTMLElement>('.range-tick--right');
    const label = `${Math.round(this.maxDrag)}px`;
    if (left) {
      left.style.left = `calc(50% - ${this.maxDrag}px)`;
      left.dataset.label = label;
    }
    if (right) {
      right.style.left = `calc(50% + ${this.maxDrag}px)`;
      right.dataset.label = label;
    }
  }

  // ---- Debug overlay ----

  private showDebugAtAnchor(clientX: number, clientY: number): void {
    if (!this.debugEl) return;
    const rect = this.el.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    (this.debugEl as unknown as HTMLElement).style.left = `${x}px`;
    (this.debugEl as unknown as HTMLElement).style.top = `${y}px`;

    const m = this.maxDrag;
    this.setSvgLine('td-axis-h', { x1: -m, y1: 0, x2: m, y2: 0 });
    this.setSvgLine('td-tick-max-l', { x1: -m, y1: -18, x2: -m, y2: 18 });
    this.setSvgLine('td-tick-max-r', { x1: m, y1: -18, x2: m, y2: 18 });
    this.setSvgText('td-label-l', { x: -m, y: -26 });
    this.setSvgText('td-label-r', { x: m, y: -26 });

    if (this.debugFinger) {
      this.debugFinger.setAttribute('cx', '0');
      this.debugFinger.setAttribute('cy', '0');
    }
    this.debugEl.classList.add('active');
  }

  private setSvgLine(id: string, attrs: { x1: number; y1: number; x2: number; y2: number }): void {
    const el = document.getElementById(id) as unknown as SVGLineElement | null;
    if (!el) return;
    el.setAttribute('x1', String(attrs.x1));
    el.setAttribute('y1', String(attrs.y1));
    el.setAttribute('x2', String(attrs.x2));
    el.setAttribute('y2', String(attrs.y2));
  }

  private setSvgText(id: string, attrs: { x: number; y: number }): void {
    const el = document.getElementById(id) as unknown as SVGTextElement | null;
    if (!el) return;
    el.setAttribute('x', String(attrs.x));
    el.setAttribute('y', String(attrs.y));
  }

  private updateDebugFinger(dx: number, dy: number): void {
    if (!this.debugFinger) return;
    this.debugFinger.setAttribute('cx', String(dx));
    this.debugFinger.setAttribute('cy', String(dy));
  }

  private hideDebug(): void {
    this.debugEl?.classList.remove('active');
  }

  private emit(input: InputState): void {
    // Emit only on meaningful changes — caller throttles further on the wire.
    if (
      Math.abs(input.steer - this.lastEmitted.steer) < 0.005 &&
      Math.abs(input.brake - this.lastEmitted.brake) < 0.005
    ) {
      return;
    }
    this.lastEmitted = input;
    this.callbacks.onChange(input);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.boundDown);
    this.el.removeEventListener('pointermove', this.boundMove);
    this.el.removeEventListener('pointerup', this.boundUp);
    this.el.removeEventListener('pointercancel', this.boundCancel);
    this.el.removeEventListener('contextmenu', this.boundContext);
  }
}
