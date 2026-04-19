// GyroInput — tilt-to-steer using DeviceOrientationEvent.
//
// The player holds the phone in landscape and tilts it like a steering
// wheel. Brake comes from the full-width BRAKE button (wired by
// ControllerGame), so this source is pure-sensor — no pointer handling.
//
// A V-shape indicator with a live needle gives the user visual feedback
// on what the sensor is reading and how the current sensitivity maps it.
//
// iOS requires an explicit `requestPermission()` call from a user gesture;
// the caller is expected to invoke `requestGyroPermission()` on a tap
// before constructing this source.

import type { InputState } from '@shared/protocol';
import {
  sensitivityToTiltRange,
  SENSITIVITY_DEFAULT,
  type InputSource,
  type InputSourceCallbacks,
} from './inputs';

// Below this |angle| there is no steer input (anti-jitter).
const TILT_DEAD_DEG = 2;
// Ease-in curve on the normalised 0..1 magnitude. Values >1 give precision
// near center (small tilts → small steer) and aggressive response near the
// limits. 1.7 is the standard middle-ground for tilt-controlled racers —
// less twitchy than linear (1.0), less numb than quadratic (2.0).
const STEER_GAMMA = 1.7;

interface DeviceOrientationRequestPermission {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
}

// Public helper: iOS needs this called from a user gesture (tap) before any
// deviceorientation events will fire.
export async function requestGyroPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  const ctor = (window as unknown as { DeviceOrientationEvent?: DeviceOrientationRequestPermission })
    .DeviceOrientationEvent;
  if (!ctor) return 'unsupported';
  if (typeof ctor.requestPermission !== 'function') return 'granted'; // non-iOS: no permission needed
  try {
    const res = await ctor.requestPermission();
    return res === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

export class GyroInput implements InputSource {
  private callbacks: InputSourceCallbacks;
  private sensitivity: number = SENSITIVITY_DEFAULT;
  private tiltRangeDeg: number = 25;

  private latestGamma = 0;
  private latestBeta = 0;
  private lastEmitted: InputState = { steer: 0, brake: 0 };

  // Tilt indicator (V-shape + needle, overlays the control surface).
  private indicator: SVGElement | null = null;
  private indicatorLeft: SVGElement | null = null;
  private indicatorRight: SVGElement | null = null;
  private indicatorNeedle: SVGElement | null = null;
  private indicatorLeftLabel: SVGTextElement | null = null;
  private indicatorRightLabel: SVGTextElement | null = null;

  private boundOrient = (e: DeviceOrientationEvent) => this.onOrient(e);

  constructor(
    callbacks: InputSourceCallbacks,
    sensitivity: number = SENSITIVITY_DEFAULT,
  ) {
    this.callbacks = callbacks;
    this.sensitivity = sensitivity;
    this.tiltRangeDeg = sensitivityToTiltRange(sensitivity);

    window.addEventListener('deviceorientation', this.boundOrient);

    // Gyro has no pixel range — hide the touchpad range indicator while active.
    document.getElementById('range-indicator')?.classList.add('hidden');

    this.indicator = document.getElementById('gyro-indicator') as unknown as SVGElement | null;
    this.indicatorLeft = document.getElementById('gyro-left-bound') as unknown as SVGElement | null;
    this.indicatorRight = document.getElementById('gyro-right-bound') as unknown as SVGElement | null;
    this.indicatorNeedle = document.getElementById('gyro-needle') as unknown as SVGElement | null;
    this.indicatorLeftLabel = document.getElementById('gyro-left-label') as unknown as SVGTextElement | null;
    this.indicatorRightLabel = document.getElementById('gyro-right-label') as unknown as SVGTextElement | null;
    this.indicator?.classList.remove('hidden');

    this.renderBounds();
    this.renderNeedle(0);
  }

  // Static V-lines at ±tiltRange from vertical (12 o'clock). Labels tucked
  // at the outer end of each bound so the user sees the target angle.
  private renderBounds(): void {
    const range = this.tiltRangeDeg;
    this.indicatorLeft?.setAttribute('transform', `rotate(${-range})`);
    this.indicatorRight?.setAttribute('transform', `rotate(${range})`);
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const labelR = 92;
    const placeLabel = (el: SVGTextElement | null, angleDeg: number, text: string) => {
      if (!el) return;
      const x = Math.sin(rad(angleDeg)) * labelR;
      const y = -Math.cos(rad(angleDeg)) * labelR;
      el.setAttribute('x', String(x));
      el.setAttribute('y', String(y));
      el.textContent = text;
    };
    placeLabel(this.indicatorLeftLabel, -range, `−${Math.round(range)}°`);
    placeLabel(this.indicatorRightLabel, range, `+${Math.round(range)}°`);
  }

  // Rotate the needle to the current steering angle, clamped to ±range so
  // it never extends beyond the V bounds.
  private renderNeedle(angle: number): void {
    const range = this.tiltRangeDeg;
    const clamped = Math.max(-range, Math.min(range, angle));
    this.indicatorNeedle?.setAttribute('transform', `rotate(${clamped})`);
  }

  // The DeviceOrientationEvent axes are fixed to the DEVICE, not the screen,
  // so when the phone is rotated to landscape the "steering-wheel tilt"
  // maps to a different axis depending on the rotation direction:
  //
  //   screen.angle = 0    (portrait)      → gamma  (+ tilt-right = +steer)
  //   screen.angle = 90   (landscape CCW) → beta   (+ tilt-right = +steer)
  //   screen.angle = 180  (portrait flip) → -gamma
  //   screen.angle = 270  (landscape CW)  → -beta
  //
  // Devices that lack screen.orientation fall back to gamma (reasonable for
  // portrait — landscape without orientation info is rare).
  private computeSteerAngle(): number {
    const angle = screen.orientation?.angle ?? 0;
    switch (angle) {
      case 90:  return this.latestBeta;
      case 180: return -this.latestGamma;
      case 270: return -this.latestBeta;
      default:  return this.latestGamma;
    }
  }

  private onOrient(e: DeviceOrientationEvent): void {
    if (e.gamma !== null) this.latestGamma = e.gamma;
    if (e.beta !== null) this.latestBeta = e.beta;
    this.computeAndEmit();
  }

  private computeAndEmit(): void {
    const raw = this.computeSteerAngle();
    this.renderNeedle(raw);
    const range = Math.max(TILT_DEAD_DEG + 1, this.tiltRangeDeg);
    const clamped = Math.max(-range, Math.min(range, raw));
    const abs = Math.abs(clamped);
    const linearMag = abs <= TILT_DEAD_DEG
      ? 0
      : (abs - TILT_DEAD_DEG) / (range - TILT_DEAD_DEG);
    // Apply ease-in so small tilts stay light and the last third of the
    // tilt range produces most of the steering authority.
    const mag = Math.pow(linearMag, STEER_GAMMA);
    const steer = (clamped < 0 ? -1 : 1) * mag;

    // Brake is button-only (ControllerGame overlays it). Source emits brake=0.
    this.emit({ steer, brake: 0 });
  }

  private emit(input: InputState): void {
    if (
      Math.abs(input.steer - this.lastEmitted.steer) < 0.005 &&
      input.brake === this.lastEmitted.brake
    ) return;
    this.lastEmitted = input;
    this.callbacks.onChange(input);
  }

  setBrakeButtonPressed(_pressed: boolean): void {
    // Reserved hook — the source currently doesn't react to brake state.
  }

  setSensitivity(value: number): void {
    this.sensitivity = value;
    this.tiltRangeDeg = sensitivityToTiltRange(value);
    this.renderBounds();
  }

  dispose(): void {
    window.removeEventListener('deviceorientation', this.boundOrient);
    document.getElementById('range-indicator')?.classList.remove('hidden');
    this.indicator?.classList.add('hidden');
  }
}
