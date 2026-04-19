import { describe, expect, test } from 'bun:test';
import {
  dragToInput,
  detectMode,
  effectiveMaxDrag,
  DEAD_ZONE,
  BRAKE_DEAD_ZONE,
  MAX_DRAG,
} from '@controller/TouchInput';

describe('effectiveMaxDrag', () => {
  test('caps at MAX_DRAG on normal-and-wider touchpads', () => {
    expect(effectiveMaxDrag(400)).toBe(MAX_DRAG);
    expect(effectiveMaxDrag(700)).toBe(MAX_DRAG);
    expect(effectiveMaxDrag(1500)).toBe(MAX_DRAG);
  });

  test('shrinks proportionally on very small touchpads (45% of width)', () => {
    expect(effectiveMaxDrag(200)).toBeCloseTo(90, 5);
    expect(effectiveMaxDrag(240)).toBeCloseTo(108, 5);
  });

  test('boundary case: exactly the cap point', () => {
    // 0.45 × width = MAX_DRAG when width = MAX_DRAG / 0.45 ≈ 311.
    expect(effectiveMaxDrag(MAX_DRAG / 0.45)).toBeCloseTo(MAX_DRAG, 5);
  });
});

describe('detectMode', () => {
  test('idle stays idle inside both dead zones', () => {
    expect(detectMode('idle', 0, 0)).toBe('idle');
    expect(detectMode('idle', DEAD_ZONE - 1, BRAKE_DEAD_ZONE - 1)).toBe('idle');
  });

  test('idle → steer when horizontal crosses first', () => {
    expect(detectMode('idle', DEAD_ZONE + 5, 0)).toBe('steer');
    expect(detectMode('idle', -(DEAD_ZONE + 5), 0)).toBe('steer');
  });

  test('idle → brake when vertical crosses brake dead zone', () => {
    expect(detectMode('idle', 0, BRAKE_DEAD_ZONE + 5)).toBe('brake');
  });

  test('an established mode never changes mid-gesture', () => {
    expect(detectMode('steer', 0, 200)).toBe('steer');
    expect(detectMode('steer', 100, 200)).toBe('steer');
    expect(detectMode('brake', 200, 0)).toBe('brake');
  });

  test('upward-only drag never commits to a mode', () => {
    expect(detectMode('idle', 0, -200)).toBe('idle');
  });
});

describe('dragToInput', () => {
  test('idle mode emits zero', () => {
    expect(dragToInput(100, 100, 'idle')).toEqual({ steer: 0, brake: 0 });
  });

  // ----- STEER mode -----

  test('steer mode never produces brake from downward drag', () => {
    const r = dragToInput(80, 200, 'steer');
    expect(r.steer).toBeGreaterThan(0);
    expect(r.brake).toBe(0);
  });

  test('steer mode ramps linearly to ±1 over [DEAD_ZONE, MAX_DRAG]', () => {
    const half = dragToInput(DEAD_ZONE + (MAX_DRAG - DEAD_ZONE) / 2, 0, 'steer');
    expect(half.steer).toBeCloseTo(0.5, 3);
    expect(half.brake).toBe(0);

    expect(dragToInput(MAX_DRAG, 0, 'steer').steer).toBeCloseTo(1, 5);
    expect(dragToInput(-MAX_DRAG, 0, 'steer').steer).toBeCloseTo(-1, 5);
  });

  // ----- BRAKE mode -----

  test('brake mode applies both axes (reverse + steer)', () => {
    const r = dragToInput(120, BRAKE_DEAD_ZONE + 40, 'brake');
    expect(r.steer).toBeGreaterThan(0);
    expect(r.brake).toBeGreaterThan(0);
  });

  test('brake mode left + brake', () => {
    const r = dragToInput(-100, BRAKE_DEAD_ZONE + 40, 'brake');
    expect(r.steer).toBeLessThan(0);
    expect(r.brake).toBeGreaterThan(0);
  });

  test('brake mode brake-only (vertical drag)', () => {
    const r = dragToInput(0, BRAKE_DEAD_ZONE + 60, 'brake');
    expect(r.brake).toBeGreaterThan(0);
    expect(r.steer).toBe(0);
  });

  test('brake mode saturates steer at 1 past maxDrag horizontally', () => {
    // In brake mode, big horizontal drag is just steer saturated at ±1.
    const r = dragToInput(MAX_DRAG + 50, BRAKE_DEAD_ZONE + 40, 'brake');
    expect(r.steer).toBeCloseTo(1, 5);
    expect(r.brake).toBeGreaterThan(0);
    expect(r.brake).toBeLessThan(1);
  });

  test('upward drag never produces brake even in brake mode', () => {
    expect(dragToInput(0, -200, 'brake')).toEqual({ steer: 0, brake: 0 });
  });

  test('brake mode brake input saturates at MAX_DRAG', () => {
    expect(dragToInput(0, MAX_DRAG + 50, 'brake').brake).toBeCloseTo(1, 5);
  });
});
