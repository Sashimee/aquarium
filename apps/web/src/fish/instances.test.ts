import { describe, expect, it } from 'vitest';
import {
  FishInstanceData,
  INSTANCE_STRIDE,
  InstanceSlot,
  WALKER_INSTANCE_STRIDE,
  WalkerSlot,
  type InstanceValues,
  type WalkerValues,
} from './instances';

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
  gills: 0.375,
  mouth: 0.125,
  display: 0.75,
  gillFlare: 0.5,
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
    expect(data.array[o + InstanceSlot.Gills]).toBe(0.375);
    expect(data.array[o + InstanceSlot.Mouth]).toBe(0.125);
    expect(data.array[o + InstanceSlot.Display]).toBe(0.75);
    expect(data.array[o + InstanceSlot.GillFlare]).toBe(0.5);
  });

  it('keeps every slot inside one stride', () => {
    for (const slot of Object.values(InstanceSlot)) expect(slot).toBeLessThan(INSTANCE_STRIDE);
    expect(INSTANCE_STRIDE % 4).toBe(0);
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

  describe('walker stride', () => {
    const walker: WalkerValues = {
      legPhase: 0.25,
      stride: 0.5,
      curl: 1.2,
      paddle: 0.75,
      pick: 0.3,
      dance: 0.125,
    };

    it('keeps the fish slots and adds the walker slots after them, inside the stride', () => {
      for (const slot of Object.values(WalkerSlot)) {
        expect(slot).toBeGreaterThanOrEqual(INSTANCE_STRIDE);
        expect(slot).toBeLessThan(WALKER_INSTANCE_STRIDE);
      }
      expect(WALKER_INSTANCE_STRIDE % 4).toBe(0);
    });

    it('writes both blocks of a walker into its own stride', () => {
      const data = new FishInstanceData(2, WALKER_INSTANCE_STRIDE);
      expect(data.array.length).toBe(2 * WALKER_INSTANCE_STRIDE);
      data.write(1, values);
      data.writeWalker(1, walker);
      const o = WALKER_INSTANCE_STRIDE;
      expect(data.array.subarray(0, o).every((v) => v === 0)).toBe(true);
      expect(data.array[o + InstanceSlot.Scale]).toBeCloseTo(1.05, 6);
      expect(data.array[o + WalkerSlot.LegPhase]).toBe(0.25);
      expect(data.array[o + WalkerSlot.Curl]).toBeCloseTo(1.2, 6);
      expect(data.array[o + WalkerSlot.Paddle]).toBe(0.75);
      expect(data.array[o + WalkerSlot.Dance]).toBe(0.125);
      expect(data.array[o + InstanceSlot.Mouth]).toBe(0.125);
    });

    it('collapses the whole walker stride', () => {
      const data = new FishInstanceData(2, WALKER_INSTANCE_STRIDE);
      data.writeWalker(0, walker);
      data.writeWalker(1, walker);
      data.collapse(0);
      expect(data.array.subarray(0, WALKER_INSTANCE_STRIDE).every((v) => v === 0)).toBe(true);
      expect(data.array[WALKER_INSTANCE_STRIDE + WalkerSlot.Stride]).toBe(0.5);
    });

    it('refuses walker values in a fish buffer, and indices outside the capacity', () => {
      expect(() => new FishInstanceData(2).writeWalker(0, walker)).toThrow(/walker stride/);
      const data = new FishInstanceData(2, WALKER_INSTANCE_STRIDE);
      expect(() => data.writeWalker(2, walker)).toThrow(RangeError);
    });
  });
});
