import { describe, expect, it } from 'vitest';
import { bakeMouthMask } from './mouth.ts';

interface Head {
  positions: Float32Array;
  finId: Float32Array;
}

/** A fish-like spindle along +z from z=0 (tail) to z=1 (snout), 0.2 tall, on an 11 x 12 ring grid, plus one dorsal fin vertex. */
function spindle(): Head {
  const positions: number[] = [];
  const finId: number[] = [];
  for (let s = 0; s <= 10; s++) {
    const z = s / 10;
    const radius = 0.1 * Math.sin(Math.PI * Math.min(1, (z + 0.05) / 1.05));
    for (let k = 0; k < 12; k++) {
      const angle = (2 * Math.PI * k) / 12;
      positions.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
      finId.push(0);
    }
  }
  positions.push(0, 0.2, 0.9);
  finId.push(2);
  return { positions: Float32Array.from(positions), finId: Float32Array.from(finId) };
}

describe('bakeMouthMask', () => {
  const head = spindle();
  const mask = bakeMouthMask(head.positions, head.finId);
  const at = (predicate: (y: number, z: number) => boolean): number[] =>
    [...mask].filter((_, i) => predicate(head.positions[i * 3 + 1]!, head.positions[i * 3 + 2]!));

  it('stays within 0..1 and peaks at exactly 1', () => {
    expect(Math.min(...mask)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...mask)).toBe(1);
  });

  it('puts the peak on the ventral side near the snout', () => {
    const peak = mask.indexOf(1);
    expect(head.positions[peak * 3 + 1]!).toBeLessThan(0);
    expect(head.positions[peak * 3 + 2]!).toBeGreaterThanOrEqual(0.8);
  });

  it('is 0 behind the gill line', () => {
    expect(Math.max(...at((_y, z) => z < 0.75))).toBe(0);
  });

  it('is 0 on the dorsal half of the head', () => {
    expect(Math.max(...at((y, z) => z > 0.8 && y > 0.02))).toBe(0);
  });

  it('falls monotonically along the ventral midline from the jaw tip to the gill line', () => {
    const tipZ = head.positions[mask.indexOf(1) * 3 + 2]!;
    const line = [...mask.keys()]
      .filter(
        (i) =>
          Math.abs(head.positions[i * 3]!) < 1e-6 &&
          head.positions[i * 3 + 1]! < 0 &&
          head.positions[i * 3 + 2]! <= tipZ,
      )
      .sort((a, b) => head.positions[b * 3 + 2]! - head.positions[a * 3 + 2]!)
      .map((i) => mask[i]!);
    expect(line.length).toBeGreaterThan(2);
    for (let i = 1; i < line.length; i++) expect(line[i]!).toBeLessThanOrEqual(line[i - 1]! + 1e-6);
  });

  it('leaves fin vertices at 0', () => {
    expect(mask[mask.length - 1]).toBe(0);
  });

  it('widens the head window with headFraction', () => {
    const longer = bakeMouthMask(head.positions, head.finId, { headFraction: 0.5 });
    const behind = [...longer].filter((_, i) => head.positions[i * 3 + 2]! < 0.45);
    expect(Math.max(...behind)).toBe(0);
    expect(longer.some((v, i) => v > 0 && head.positions[i * 3 + 2]! < 0.75)).toBe(true);
  });

  it('is deterministic', () => {
    expect(bakeMouthMask(head.positions, head.finId)).toEqual(mask);
  });

  it('throws when there is no body vertex', () => {
    expect(() => bakeMouthMask(new Float32Array([0, 0, 0]), Float32Array.from([1]))).toThrow(
      'no body vertex',
    );
  });
});
