// KeyboardDebug — dev-only keyboard input source. Enabled via ?debug=1.
// Drives one human car directly, bypassing Party-Sockets, so the dev loop
// doesn't need a phone.
//
// Bindings:
//   ←/A  steer left
//   →/D  steer right
//   ↓/S/Space  brake (ramps up over BRAKE_RAMP_TIME)
//   ↑/W  not used — auto-throttle is always on
//
// The brake input ramps from 0 → 1 over BRAKE_RAMP_TIME seconds while held,
// and ramps back to 0 just as fast on release. Without this, S → instant
// full brake feels jarring (matches how touch input has a natural drag ramp).

import type { Car } from './Car';

const BRAKE_RAMP_TIME = 0.35; // seconds to go from 0 → full brake

export class KeyboardDebug {
  private car: Car;
  private keys = new Set<string>();
  private brakeLevel = 0;
  private boundDown = (e: KeyboardEvent) => this.keys.add(e.key.toLowerCase());
  private boundUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());

  constructor(car: Car) {
    this.car = car;
    window.addEventListener('keydown', this.boundDown);
    window.addEventListener('keyup', this.boundUp);
  }

  // Called once per frame from DisplayGame's render loop.
  tick(dt: number): void {
    let steer = 0;
    if (this.keys.has('arrowleft') || this.keys.has('a')) steer -= 1;
    if (this.keys.has('arrowright') || this.keys.has('d')) steer += 1;

    const braking =
      this.keys.has('arrowdown') || this.keys.has('s') || this.keys.has(' ');
    const target = braking ? 1 : 0;
    const step = dt / BRAKE_RAMP_TIME;
    if (this.brakeLevel < target) this.brakeLevel = Math.min(target, this.brakeLevel + step);
    else if (this.brakeLevel > target) this.brakeLevel = Math.max(target, this.brakeLevel - step);

    this.car.applyInput({ steer, brake: this.brakeLevel });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.boundDown);
    window.removeEventListener('keyup', this.boundUp);
  }
}
