// Controller input source abstraction.
//
// Two implementations live alongside this file:
//   - TouchInput — drag-from-touchdown (horizontal drag → steer)
//   - GyroInput  — tilt-to-steer via DeviceOrientationEvent
//
// Each source emits an InputState via `onChange` and exposes two setters the
// controller uses at runtime:
//   - setBrakeButtonPressed(pressed) — forwarded state of the BRAKE button
//                                      (hook reserved; sources don't use it
//                                      today, but kept for future use)
//   - setSensitivity(value)          — 0..100, remaps the source's range

import type { InputState } from '@shared/protocol';

// touch_a: pad primary, brake secondary (pad left / brake right in landscape)
// touch_b: landscape-only swap (brake left / pad right) — falls back to A
//          visually in portrait, stays selected for when the user rotates.
// gyro:    tilt to steer, full-width brake button.
export type InputMode = 'touch_a' | 'touch_b' | 'gyro';

export interface InputSourceCallbacks {
  onChange: (input: InputState) => void;
}

export interface InputSource {
  dispose(): void;
  setBrakeButtonPressed(pressed: boolean): void;
  // 0..100 user-controlled sensitivity. Higher = tighter range (less drag /
  // less tilt needed for full steer). Each source maps this to its own
  // physical range via `sensitivityToTouchRange` / `sensitivityToTiltRange`.
  setSensitivity(value: number): void;
}

// --- Settings persistence (localStorage) ---

const LS_INPUT_MODE = 'racer_input_mode';
const LS_SENSITIVITY_TOUCH = 'racer_sensitivity_touchpad';
const LS_SENSITIVITY_GYRO = 'racer_sensitivity_gyro';

const INPUT_MODES: InputMode[] = ['touch_a', 'touch_b', 'gyro'];

export function loadInputMode(): InputMode {
  try {
    const v = localStorage.getItem(LS_INPUT_MODE);
    if (v && (INPUT_MODES as string[]).includes(v)) return v as InputMode;
    // Legacy migration: old single-touchpad value maps to touch_a.
    if (v === 'touchpad') return 'touch_a';
  } catch { /* ignore */ }
  return 'touch_a';
}
export function saveInputMode(mode: InputMode): void {
  try { localStorage.setItem(LS_INPUT_MODE, mode); } catch { /* ignore */ }
}

// --- Sensitivity ---
// Stored per input mode as a 0..100 integer. Touch and gyro have very
// different "feel" envelopes so they get independent storage slots.
export const SENSITIVITY_DEFAULT = 50;
export const SENSITIVITY_MIN = 0;
export const SENSITIVITY_MAX = 100;

function sensitivityKey(mode: InputMode): string {
  // Touch A and Touch B are physically the same — only layout differs —
  // so they share the "touch" slot. Gyro has its own envelope.
  return mode === 'gyro' ? LS_SENSITIVITY_GYRO : LS_SENSITIVITY_TOUCH;
}

export function loadSensitivity(mode: InputMode): number {
  try {
    const v = localStorage.getItem(sensitivityKey(mode));
    if (v !== null) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) return Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, n));
    }
  } catch { /* ignore */ }
  return SENSITIVITY_DEFAULT;
}
export function saveSensitivity(mode: InputMode, value: number): void {
  try { localStorage.setItem(sensitivityKey(mode), String(Math.round(value))); } catch { /* ignore */ }
}

// Piecewise-linear lerp through (0, y0) → (0.5, yMid) → (1, y100). Lets us
// anchor the default (s=50) to a specific tuned value while keeping loose
// and tight endpoints independent.
function piecewise(s: number, y0: number, yMid: number, y100: number): number {
  return s < 0.5
    ? y0 + (yMid - y0) * (s / 0.5)
    : yMid + (y100 - yMid) * ((s - 0.5) / 0.5);
}

// Map 0..100 sensitivity → touchpad max-drag in pixels. Capped by `padWidth`
// (45% of the pad) so the indicator never spills off a narrow pad.
// s=0   → 200 px  (loose)
// s=50  → 118 px  (default — feels right on a typical phone)
// s=100 →  40 px  (hair-trigger)
export function sensitivityToTouchRange(value: number, padWidth: number): number {
  const s = Math.max(0, Math.min(100, value)) / 100;
  const ideal = piecewise(s, 200, 118, 40);
  const cap = padWidth * 0.45;
  return Math.min(ideal, cap);
}

// Map 0..100 sensitivity → gyro max tilt in degrees.
// s=0   → 90° (phone sideways = max steer)
// s=50  → 45° (default — comfortable steering-wheel tilt)
// s=100 →  8° (nudge = max steer)
export function sensitivityToTiltRange(value: number): number {
  const s = Math.max(0, Math.min(100, value)) / 100;
  return piecewise(s, 90, 45, 8);
}
