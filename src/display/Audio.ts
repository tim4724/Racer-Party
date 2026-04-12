// Audio — Web Audio engine loop + simple SFX generators.
//
// Engine sound: one oscillator per car, lowpass-filtered, pitch tied to
// |linear velocity|. SFX (countdown beep, lap bell) are generated from
// short oscillator envelopes — no asset files to load.
//
// Must be initialized after a user gesture (browser autoplay policy).

import type { Car } from './Car';

const MASTER_VOLUME = 0.4;

export class Audio {
  ctx: AudioContext | null = null;
  masterGain: GainNode | null = null;
  carNodes = new Map<number, { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode }>();
  muted = false;

  init(): void {
    if (this.ctx) return;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : MASTER_VOLUME;
    this.masterGain.connect(this.ctx.destination);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(t);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, t);
    this.masterGain.gain.linearRampToValueAtTime(muted ? 0 : MASTER_VOLUME, t + 0.08);
  }

  attachCar(car: Car): void {
    if (!this.ctx || !this.masterGain) return;
    if (this.carNodes.has(car.carId)) return;

    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 55;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;

    const gain = this.ctx.createGain();
    gain.gain.value = 0.0;

    osc.connect(filter).connect(gain).connect(this.masterGain);
    osc.start();

    this.carNodes.set(car.carId, { osc, gain, filter });
  }

  // Update engine pitch + volume for one car based on its speed (m/s).
  // Only the local viewport's engine should be audible — pass `audible`.
  //
  // Pitch range tuned for a rumbly engine feel: idle at 55 Hz (A1, deep
  // rumble), rising to ~170 Hz at top speed. Previous values were roughly
  // an octave higher and sounded like a dentist drill at max speed.
  setCarSpeed(carId: number, speed: number, audible: boolean): void {
    const node = this.carNodes.get(carId);
    if (!node || !this.ctx) return;
    const norm = Math.min(speed / 40, 1.0);
    const targetFreq = 55 + norm * 115;
    const targetGain = audible ? 0.05 + norm * 0.12 : 0;
    const t = this.ctx.currentTime;
    node.osc.frequency.linearRampToValueAtTime(targetFreq, t + 0.05);
    node.gain.gain.linearRampToValueAtTime(targetGain, t + 0.05);
  }

  // ---- SFX (one-shots) ----

  beep(freq = 880, duration = 0.15): void {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(this.masterGain);
    osc.start(t);
    osc.stop(t + duration);
  }

  countdownTick(): void {
    this.beep(660, 0.12);
  }

  countdownGo(): void {
    this.beep(1320, 0.35);
  }

  lapBell(): void {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    for (const f of [880, 1320]) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      osc.connect(gain).connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.6);
    }
  }

  dispose(): void {
    for (const node of this.carNodes.values()) {
      try { node.osc.stop(); } catch { /* ignore */ }
    }
    this.carNodes.clear();
    if (this.ctx) {
      this.ctx.close().catch(() => { /* ignore */ });
      this.ctx = null;
    }
  }
}
