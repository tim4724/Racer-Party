import { describe, expect, test } from 'bun:test';
import { computeLayout } from '@display/SplitScreen';

describe('computeLayout', () => {
  test('N=1 fills the whole screen', () => {
    const v = computeLayout(1, 1920, 1080);
    expect(v.length).toBe(1);
    expect(v[0]).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test('N=2 on 16:9 splits horizontally (1 row × 2 cols)', () => {
    const v = computeLayout(2, 1920, 1080);
    expect(v.length).toBe(2);
    // Two equal-width columns, full height.
    expect(v[0].w + v[1].w).toBe(1920);
    expect(v[0].h).toBe(1080);
    expect(v[1].h).toBe(1080);
  });

  test('N=3 on 16:9 yields 2 rows × 2 cols', () => {
    const v = computeLayout(3, 1920, 1080);
    expect(v.length).toBe(3);
    // Each tile should be ~half-width and ~half-height.
    expect(v[0].w).toBe(960);
    expect(v[0].h).toBe(540);
  });

  test('N=4 on 16:9 yields 2 rows × 2 cols', () => {
    const v = computeLayout(4, 1920, 1080);
    expect(v.length).toBe(4);
    for (const tile of v) {
      expect(tile.w).toBe(960);
      expect(tile.h).toBe(540);
    }
  });

  test('returns empty array for N=0', () => {
    expect(computeLayout(0, 1920, 1080)).toEqual([]);
  });

  test('N=2 on portrait yields 2 rows × 1 col', () => {
    const v = computeLayout(2, 540, 960);
    expect(v.length).toBe(2);
    // Each tile should be full-width and half-height.
    expect(v[0].w).toBe(540);
    expect(v[0].h + v[1].h).toBe(960);
  });
});
