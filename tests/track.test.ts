import { describe, expect, test } from 'bun:test';
import { Track } from '@display/Track';

describe('Track', () => {
  const track = new Track();

  test('centerline forms a closed loop', () => {
    const first = track.centerline[0];
    const last = track.centerline[track.centerline.length - 1];
    // First and last should not be identical (we want N samples around the loop),
    // but they should be reasonably close (the next-after-last is back to first).
    expect(first.distanceTo(last)).toBeLessThan(60);
  });

  test('checkpoints are indexed 0..N-1 in order', () => {
    expect(track.checkpoints.length).toBeGreaterThan(0);
    track.checkpoints.forEach((cp, i) => expect(cp.index).toBe(i));
  });

  test('checkpoint forwards are unit vectors', () => {
    for (const cp of track.checkpoints) {
      expect(cp.forward.length()).toBeCloseTo(1, 4);
    }
  });

  test('spawnPoints has 4 distinct positions', () => {
    expect(track.spawnPoints.length).toBe(4);
    const seen = new Set<string>();
    for (const sp of track.spawnPoints) {
      seen.add(`${sp.position.x.toFixed(2)},${sp.position.z.toFixed(2)}`);
    }
    expect(seen.size).toBe(4);
  });

  test('closestWaypointIndex returns the nearest centerline point', () => {
    const target = track.centerline[10].clone();
    target.x += 0.001;
    expect(track.closestWaypointIndex(target)).toBe(10);
  });
});
