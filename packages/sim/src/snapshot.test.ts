import { describe, expect, it } from 'vitest';
import { quatFromYawPitchRoll } from './math.ts';
import {
  FishState,
  interpolateSnapshots,
  SNAPSHOT_STRIDE,
  SnapshotField,
  SnapshotInterpolator,
  type Snapshot,
} from './snapshot.ts';

function fish(x: number, yaw: number, speed: number, state: FishState): Float32Array {
  const out = new Float32Array(SNAPSHOT_STRIDE);
  out[SnapshotField.PosX] = x;
  out[SnapshotField.PosY] = 0.2;
  out[SnapshotField.PosZ] = -x;
  quatFromYawPitchRoll(yaw, 0, 0, out, SnapshotField.QuatX);
  out[SnapshotField.Speed] = speed;
  out[SnapshotField.YawRate] = 0;
  out[SnapshotField.State] = state;
  return out;
}

function snap(tick: number, data: Float32Array, epoch = 1): Snapshot {
  return { epoch, tick, time: tick / 30, data };
}

describe('interpolateSnapshots', () => {
  it('lerps position and speed and slerp-like blends rotation', () => {
    const a = fish(0, 0, 0.1, FishState.Cruise);
    const b = fish(1, 1, 0.3, FishState.Avoid);
    const out = new Float32Array(SNAPSHOT_STRIDE);
    interpolateSnapshots(a, b, 0.25, out);
    expect(out[SnapshotField.PosX]).toBeCloseTo(0.25, 6);
    expect(out[SnapshotField.PosZ]).toBeCloseTo(-0.25, 6);
    expect(out[SnapshotField.Speed]).toBeCloseTo(0.15, 6);
    expect(out[SnapshotField.State]).toBe(FishState.Cruise);
    const q = out.subarray(SnapshotField.QuatX, SnapshotField.QuatW + 1);
    expect(Math.hypot(...q)).toBeCloseTo(1, 6);
    const yaw = 2 * Math.atan2(q[1] ?? 0, q[3] ?? 1);
    expect(yaw).toBeGreaterThan(0.15);
    expect(yaw).toBeLessThan(0.35);
    interpolateSnapshots(a, b, 0.75, out);
    expect(out[SnapshotField.State]).toBe(FishState.Avoid);
  });

  it('lerps thrust so the tail beat eases between steps', () => {
    const a = fish(0, 0, 0.1, FishState.Cruise);
    const b = fish(0, 0, 0.1, FishState.Startle);
    a[SnapshotField.Thrust] = 0;
    b[SnapshotField.Thrust] = 1;
    const out = new Float32Array(SNAPSHOT_STRIDE);
    interpolateSnapshots(a, b, 0.25, out);
    expect(out[SnapshotField.Thrust]).toBeCloseTo(0.25, 6);
    interpolateSnapshots(a, b, 1, out);
    expect(out[SnapshotField.Thrust]).toBe(1);
  });

  it('lerps the display and gill flare so fins and gill covers open smoothly', () => {
    const a = fish(0, 0, 0, FishState.Station);
    const b = fish(0, 0, 0, FishState.Display);
    b[SnapshotField.Display] = 1;
    b[SnapshotField.GillFlare] = 0.5;
    const out = new Float32Array(SNAPSHOT_STRIDE);
    interpolateSnapshots(a, b, 0.5, out);
    expect(out[SnapshotField.Display]).toBeCloseTo(0.5, 6);
    expect(out[SnapshotField.GillFlare]).toBeCloseTo(0.25, 6);
  });

  it('lerps the pectoral fan, the last field of each record, fish by fish', () => {
    expect(SnapshotField.Fan).toBe(SNAPSHOT_STRIDE - 1);
    const a = new Float32Array(2 * SNAPSHOT_STRIDE);
    const b = new Float32Array(2 * SNAPSHOT_STRIDE);
    a.set(fish(0, 0, 0, FishState.Station), 0);
    a.set(fish(1, 0, 0, FishState.Station), SNAPSHOT_STRIDE);
    b.set(fish(0, 0, 0, FishState.Tend), 0);
    b.set(fish(1, 0, 0, FishState.Station), SNAPSHOT_STRIDE);
    b[SnapshotField.Fan] = 1;
    const out = new Float32Array(2 * SNAPSHOT_STRIDE);
    interpolateSnapshots(a, b, 0.25, out);
    expect(out[SnapshotField.Fan]).toBeCloseTo(0.25, 6);
    expect(out[SNAPSHOT_STRIDE + SnapshotField.Fan]).toBe(0);
    expect(out[SNAPSHOT_STRIDE + SnapshotField.PosX]).toBeCloseTo(1, 6);
  });

  it('takes the short way round when the quaternions are in opposite hemispheres', () => {
    const a = fish(0, Math.PI - 0.1, 0, FishState.Cruise);
    const b = fish(0, -Math.PI + 0.1, 0, FishState.Cruise);
    const out = new Float32Array(SNAPSHOT_STRIDE);
    interpolateSnapshots(a, b, 0.5, out);
    const yaw = 2 * Math.atan2(out[SnapshotField.QuatY] ?? 0, out[SnapshotField.QuatW] ?? 1);
    expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(1e-3);
  });

  it('clamps alpha to [0, 1]', () => {
    const a = fish(0, 0, 0, FishState.Cruise);
    const b = fish(1, 0, 0, FishState.Cruise);
    const out = new Float32Array(SNAPSHOT_STRIDE);
    interpolateSnapshots(a, b, 3, out);
    expect(out[SnapshotField.PosX]).toBe(1);
    interpolateSnapshots(a, b, -1, out);
    expect(out[SnapshotField.PosX]).toBe(0);
  });

  it('rejects mismatched sizes', () => {
    const a = new Float32Array(SNAPSHOT_STRIDE);
    const b = new Float32Array(SNAPSHOT_STRIDE * 2);
    expect(() => interpolateSnapshots(a, b, 0.5, new Float32Array(b.length))).toThrow(/re-init/);
  });
});

describe('SnapshotInterpolator', () => {
  it('reports nothing before the first snapshot', () => {
    const it = new SnapshotInterpolator(1 / 30);
    expect(it.sample(0, new Float32Array(SNAPSHOT_STRIDE))).toBe(false);
  });

  it('renders one step in the past between the two newest snapshots', () => {
    const interp = new SnapshotInterpolator(1 / 30);
    const out = new Float32Array(SNAPSHOT_STRIDE);
    expect(interp.push(snap(0, fish(0, 0, 0, FishState.Cruise)), 1000)).toBeNull();
    expect(interp.sample(1000, out)).toBe(true);
    expect(out[SnapshotField.PosX]).toBe(0);

    expect(interp.push(snap(1, fish(1, 0, 0, FishState.Cruise)), 1033)).toBeNull();
    interp.sample(1033, out);
    expect(out[SnapshotField.PosX]).toBeCloseTo(0, 5);
    interp.sample(1033 + 1000 / 60, out);
    expect(out[SnapshotField.PosX]).toBeCloseTo(0.5, 5);
  });

  it('evicts the oldest snapshot for recycling and ignores stale ones', () => {
    const interp = new SnapshotInterpolator(1 / 30);
    const s0 = snap(0, fish(0, 0, 0, FishState.Cruise));
    const s1 = snap(1, fish(1, 0, 0, FishState.Cruise));
    const s2 = snap(2, fish(2, 0, 0, FishState.Cruise));
    interp.push(s0, 0);
    interp.push(s1, 33);
    expect(interp.push(s2, 66)).toBe(s0);
    const stale = snap(1, fish(9, 0, 0, FishState.Cruise));
    expect(interp.push(stale, 70)).toBe(stale);
  });

  it('starts a fresh window after a re-init restarts ticks at 0', () => {
    const interp = new SnapshotInterpolator(1 / 30);
    const out = new Float32Array(SNAPSHOT_STRIDE);
    interp.push(snap(0, fish(0, 0, 0, FishState.Cruise), 1), 0);
    interp.push(snap(40, fish(4, 0, 0, FishState.Cruise), 1), 33);

    const fresh = snap(0, fish(7, 0, 0, FishState.Cruise), 2);
    expect(interp.push(fresh, 100)).toBeNull();
    interp.sample(100, out);
    expect(out[SnapshotField.PosX]).toBe(7);

    expect(interp.push(snap(1, fish(8, 0, 0, FishState.Cruise), 2), 133)).toBeNull();
    interp.sample(133 + 1000 / 60, out);
    expect(out[SnapshotField.PosX]).toBeCloseTo(7.5, 5);

    const late = snap(41, fish(9, 0, 0, FishState.Cruise), 1);
    expect(interp.push(late, 140)).toBe(late);
    expect(interp.push(snap(2, fish(9, 0, 0, FishState.Cruise), 2), 166)).toBe(fresh);
  });

  it('forgets everything on reset', () => {
    const interp = new SnapshotInterpolator(1 / 30);
    interp.push(snap(5, fish(1, 0, 0, FishState.Cruise)), 0);
    interp.reset();
    expect(interp.sample(0, new Float32Array(SNAPSHOT_STRIDE))).toBe(false);
    expect(interp.renderTime(1000)).toBe(0);
    expect(interp.push(snap(0, fish(2, 0, 0, FishState.Cruise)), 10)).toBeNull();
  });
});
