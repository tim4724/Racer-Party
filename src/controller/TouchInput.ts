// TouchInput — pointer-event drag → continuous {steer, brake} for the
// controller side. Pure logic (no DOM rendering); the consumer wires
// `onChange` to the network layer.
//
// Mode-locked drag model. The first axis to cross its dead zone picks the
// gesture mode for the rest of the touch:
//
//   STEER mode (horizontal first):
//     - Horizontal offset ramps steer 0 → ±1 over [DEAD_ZONE, maxDrag] px.
//     - Vertical drag is IGNORED — no accidental brake while steering.
//
//   BRAKE mode (vertical first, dy > BRAKE_DEAD_ZONE):
//     - Vertical offset ramps brake 0 → 1 over `maxDrag` px.
//     - Horizontal offset is also active so the player can steer while
//       braking / reversing (reverse-while-turning still works).
//
// Lift the finger to reset; the next touch picks a fresh mode.
//
// Tested in tests/touchinput.test.ts via the pure helpers `detectMode`
// and `dragToInput`.

import { clamp, type InputState } from '@shared/protocol';

export const DEAD_ZONE = 20;        // steer dead zone
export const BRAKE_DEAD_ZONE = 50;  // brake dead zone (more deliberate)
// Default max steer distance. Capped per-gesture at 45 % of the touchpad
// width on small screens, but never more than this — a thumb's reach is
// what matters, not the screen size. See `effectiveMaxDrag`.
export const MAX_DRAG = 120;

export type GestureMode = 'idle' | 'steer' | 'brake';

// Compute the effective max steer drag for a touchpad of the given width.
// min(MAX_DRAG, 0.45 × width) — capped so full lock is always within
// thumb reach regardless of screen size; only shrinks below MAX_DRAG on
// very small touchpads (≤ 311 px wide).
export function effectiveMaxDrag(touchpadWidthPx: number): number {
  return Math.min(MAX_DRAG, touchpadWidthPx * 0.45);
}

// Decide which mode the gesture is in given the current cumulative drag
// and current mode. Once a mode is chosen, it sticks for the rest of the
// gesture (caller resets to 'idle' on pointerup).
export function detectMode(current: GestureMode, dx: number, dy: number): GestureMode {
  if (current !== 'idle') return current;
  // Brake commit (vertical) is checked first because its dead zone is
  // larger — it requires a more deliberate downward drag.
  if (dy > BRAKE_DEAD_ZONE) return 'brake';
  if (Math.abs(dx) > DEAD_ZONE) return 'steer';
  return 'idle';
}

// Pure mapping from drag offset → input, given gesture mode.
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

  // mode === 'brake': both axes active so the player can reverse + steer.
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

export interface TouchInputCallbacks {
  onChange: (input: InputState) => void;
}

export class TouchInput {
  el: HTMLElement;
  callbacks: TouchInputCallbacks;
  activePointerId: number | null = null;
  anchorX = 0;
  anchorY = 0;
  // Effective max drag for this gesture. Recomputed on each pointerdown so
  // it adapts to the current touchpad width (orientation change, resize…).
  private maxDrag: number = MAX_DRAG;
  // Per-gesture mode lock — see the file header comment.
  private mode: GestureMode = 'idle';
  lastEmitted: InputState = { steer: 0, brake: 0 };
  hapticArmed = true;

  // Drag-debug overlay (optional). Anchored to the touchdown point and
  // updated on every move so the player can see their dead zones + range.
  private debugEl: SVGElement | null = null;
  private debugFinger: SVGCircleElement | null = null;

  private boundDown = (e: PointerEvent) => this.onPointerDown(e);
  private boundMove = (e: PointerEvent) => this.onPointerMove(e);
  private boundUp = (e: PointerEvent) => this.onPointerUp(e);
  private boundCancel = (e: PointerEvent) => this.onPointerUp(e);
  private boundContext = (e: Event) => e.preventDefault();

  constructor(el: HTMLElement, callbacks: TouchInputCallbacks) {
    this.el = el;
    this.callbacks = callbacks;
    this.el.style.touchAction = 'none';

    this.el.addEventListener('pointerdown', this.boundDown);
    this.el.addEventListener('pointermove', this.boundMove);
    this.el.addEventListener('pointerup', this.boundUp);
    this.el.addEventListener('pointercancel', this.boundCancel);
    this.el.addEventListener('contextmenu', this.boundContext);

    // Attach to optional debug overlay if it exists in the DOM.
    this.debugEl = document.getElementById('touch-debug') as SVGElement | null;
    this.debugFinger = document.getElementById('td-finger') as unknown as SVGCircleElement | null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (this.activePointerId !== null) return;
    e.preventDefault();
    this.activePointerId = e.pointerId;
    this.el.setPointerCapture(e.pointerId);
    this.anchorX = e.clientX;
    this.anchorY = e.clientY;
    this.maxDrag = effectiveMaxDrag(this.el.clientWidth);
    this.mode = 'idle';
    this.hapticArmed = true;
    this.showDebugAtAnchor(e.clientX, e.clientY);
    this.emit({ steer: 0, brake: 0 });
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== this.activePointerId) return;
    const dx = e.clientX - this.anchorX;
    const dy = e.clientY - this.anchorY;
    this.mode = detectMode(this.mode, dx, dy);
    const input = dragToInput(dx, dy, this.mode, this.maxDrag);
    if (input.brake > 0.1 && this.hapticArmed) {
      this.haptic(15);
      this.hapticArmed = false;
    } else if (input.brake === 0) {
      this.hapticArmed = true;
    }
    this.updateDebugFinger(dx, dy);
    this.emit(input);
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    this.mode = 'idle';
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    this.hideDebug();
    this.emit({ steer: 0, brake: 0 });
  }

  // ---- Debug overlay ----

  private showDebugAtAnchor(clientX: number, clientY: number): void {
    if (!this.debugEl) return;
    const rect = this.el.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    (this.debugEl as unknown as HTMLElement).style.left = `${x}px`;
    (this.debugEl as unknown as HTMLElement).style.top = `${y}px`;

    // Reposition the dynamic SVG markers to match the effective max drag.
    // The static SVG ships with placeholder x/y values; we overwrite them
    // here so the player can see the actual range for the current touchpad.
    const m = this.maxDrag;
    this.setSvgLine('td-axis-h', { x1: -m, y1: 0, x2: m, y2: 0 });
    this.setSvgLine('td-axis-v', { x1: 0, y1: 0, x2: 0, y2: m });
    this.setSvgLine('td-tick-max-l', { x1: -m, y1: -18, x2: -m, y2: 18 });
    this.setSvgLine('td-tick-max-r', { x1: m, y1: -18, x2: m, y2: 18 });
    this.setSvgLine('td-tick-brake-max', { x1: -18, y1: m, x2: 18, y2: m });
    this.setSvgText('td-label-l', { x: -m, y: -26 });
    this.setSvgText('td-label-r', { x: m, y: -26 });
    this.setSvgText('td-label-brake', { x: 0, y: m + 20 });

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

  private haptic(pattern: number | number[]): void {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.boundDown);
    this.el.removeEventListener('pointermove', this.boundMove);
    this.el.removeEventListener('pointerup', this.boundUp);
    this.el.removeEventListener('pointercancel', this.boundCancel);
    this.el.removeEventListener('contextmenu', this.boundContext);
  }
}
