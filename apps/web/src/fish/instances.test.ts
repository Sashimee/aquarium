import { describe, expect, it } from 'vitest';
import { FishInstanceData, INSTANCE_STRIDE, InstanceSlot, type InstanceValues } from './instances';

const values: InstanceValues = {
  qx: 0.1,
  qy: 0.2,
  qz: 0.3,
  qw: 0.9,
  scale: 1.05,
  phase: 2.5,
  amplitude: 0.75,
  curvature: -4,
  finPhase: 1.25,
  pale: 0.5,
  seed: 0.625,
  filmThickness: 320,
  tint: [0.9, 1, 1.1],
};

describe('FishInstanceData', () => {
  it('writes each instance into its own stride of the interleaved buffer', () => {
    const data = new FishInstanceData(3);
    data.write(1, values);
    const o = INSTANCE_STRIDE;
    expect(data.array.subarray(0, o).every((v) => v === 0)).toBe(true);
    expect(data.array.subarray(2 * o).every((v) => v === 0)).toBe(true);
    expect(data.array[o + InstanceSlot.QuatW]).toBeCloseTo(0.9, 6);
    expect(data.array[o + InstanceSlot.Scale]).toBeCloseTo(1.05, 6);
    expect(data.array[o + InstanceSlot.Curvature]).toBe(-4);
    expect(data.array[o + InstanceSlot.Seed]).toBe(0.625);
    expect(data.array[o + InstanceSlot.FilmThickness]).toBe(320);
    expect(data.array[o + InstanceSlot.TintB]).toBeCloseTo(1.1, 6);
    expect(data.array[o + 15]).toBe(0);
  });

  it('keeps every slot inside one stride', () => {
    for (const slot of Object.values(InstanceSlot)) expect(slot).toBeLessThan(INSTANCE_STRIDE);
    expect(new Set(Object.values(InstanceSlot)).size).toBe(Object.values(InstanceSlot).length);
  });

  it('rejects indices outside the capacity', () => {
    const data = new FishInstanceData(2);
    expect(() => data.write(2, values)).toThrow(RangeError);
    expect(() => data.write(-1, values)).toThrow(RangeError);
    expect(() => data.write(Number.NaN, values)).toThrow(RangeError);
  });

  it('collapses one slot to zero scale and leaves its neighbours alone', () => {
    const data = new FishInstanceData(2);
    data.write(0, values);
    data.write(1, values);
    data.collapse(0);
    expect(data.array.subarray(0, INSTANCE_STRIDE).every((v) => v === 0)).toBe(true);
    expect(data.array[INSTANCE_STRIDE + InstanceSlot.Scale]).toBeCloseTo(1.05, 6);
    expect(() => data.collapse(2)).toThrow(RangeError);
  });

  it('rejects an empty or fractional capacity', () => {
    expect(() => new FishInstanceData(0)).toThrow(RangeError);
    expect(() => new FishInstanceData(1.5)).toThrow(RangeError);
  });

  it('flags the buffer for upload on commit', () => {
    const data = new FishInstanceData(1);
    const before = data.buffer.version;
    data.commit();
    expect(data.buffer.version).toBe(before + 1);
  });
});
