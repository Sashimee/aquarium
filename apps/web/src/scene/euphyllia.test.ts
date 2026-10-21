import { describe, expect, it } from 'vitest';
import type { DecorItem } from '@aquarium/shared';
import {
  EUPHYLLIA_DETAIL,
  EUPHYLLIA_TRIANGLE_BUDGET,
  euphylliaCollider,
  euphylliaId,
  euphylliaReach,
  euphylliaTriangles,
  generateEuphyllia,
  LEAN_SECONDS,
  parseEuphylliaId,
  type EuphylliaDetail,
  type EuphylliaMesh,
  type EuphylliaVariant,
} from './euphyllia';

const VARIANTS: readonly EuphylliaVariant[] = ['hammer', 'torch'];
const DETAILS: readonly EuphylliaDetail[] = [0, 1, 2];
const item: DecorItem = {
  assetId: 'euphyllia-hammer-3',
  position: [0.1, 0.07, 0.05],
  rotationY: 0.4,
  scale: 1,
};

describe('euphyllia ids', () => {
  it('round-trips variant and seed', () => {
    expect(parseEuphylliaId(euphylliaId('torch', 42))).toEqual({ variant: 'torch', seed: 42 });
  });

  it('accepts a bare zero seed', () => {
    expect(parseEuphylliaId('euphyllia-torch-0')).toEqual({ variant: 'torch', seed: 0 });
  });

  it('ignores catalog assets and malformed ids', () => {
    for (const id of [
      'brain-coral',
      'euphyllia-fan-1',
      'euphyllia-hammer-',
      'euphyllia-torch-x',
      'euphyllia-hammer-03',
      'euphyllia-torch-00',
    ]) {
      expect(parseEuphylliaId(id), id).toBeNull();
    }
  });
});

describe('generateEuphyllia', () => {
  it('is deterministic for a seed, and differs between seeds', () => {
    for (const variant of VARIANTS) {
      const a = generateEuphyllia(variant, 11, 2);
      const b = generateEuphyllia(variant, 11, 2);
      expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
      expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
      expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
      const other = generateEuphyllia(variant, 12, 2);
      expect(Array.from(other.positions)).not.toEqual(Array.from(a.positions));
    }
  });

  it('keeps the same colony shape at every detail', () => {
    for (const variant of VARIANTS) {
      const heads = DETAILS.map((d) => generateEuphyllia(variant, 5, d).heads);
      expect(new Set(heads).size).toBe(1);
      const high = generateEuphyllia(variant, 5, 2);
      const low = generateEuphyllia(variant, 5, 0);
      expect(low.bounds.max[1]).toBeGreaterThan(high.bounds.max[1] * 0.8);
      expect(low.bounds.max[1]).toBeLessThan(high.bounds.max[1] * 1.25);
    }
  });

  it('stays inside the triangle budget of its detail across seeds', () => {
    for (const variant of VARIANTS) {
      for (const detail of DETAILS) {
        for (let seed = 1; seed <= 40; seed++) {
          const tris = euphylliaTriangles(generateEuphyllia(variant, seed, detail));
          expect(tris, `${variant} seed ${seed} detail ${detail}`).toBeLessThanOrEqual(
            EUPHYLLIA_TRIANGLE_BUDGET[detail],
          );
        }
      }
    }
  });

  it('gets cheaper at lower detail', () => {
    for (const variant of VARIANTS) {
      const cost = DETAILS.map((d) => euphylliaTriangles(generateEuphyllia(variant, 9, d)));
      expect(cost[0]).toBeLessThan(cost[1] as number);
      expect(cost[1]).toBeLessThan(cost[2] as number);
    }
  });

  it('emits valid, finite, consistently sized buffers', () => {
    for (const variant of VARIANTS) {
      const mesh = generateEuphyllia(variant, 7, 2);
      const count = mesh.positions.length / 3;
      expect(mesh.normals.length).toBe(count * 3);
      expect(mesh.colors.length).toBe(count * 3);
      expect(mesh.sway.length).toBe(count);
      expect(mesh.positions.every(Number.isFinite)).toBe(true);
      expect(mesh.normals.every(Number.isFinite)).toBe(true);
      expect(Math.max(...mesh.indices)).toBeLessThan(count);
      expect(mesh.heads).toBeGreaterThanOrEqual(4);
    }
  });

  it('grows upward from the base to a hand-sized colony, with rigid skeleton and moving tips', () => {
    for (const variant of VARIANTS) {
      const mesh = generateEuphyllia(variant, 21, 2);
      expect(mesh.bounds.min[1]).toBeGreaterThan(-0.005);
      expect(mesh.bounds.max[1]).toBeGreaterThan(0.06);
      expect(mesh.bounds.max[1]).toBeLessThan(0.2);
      expect(Math.min(...mesh.sway)).toBe(0);
      expect(Math.max(...mesh.sway)).toBe(1);
      expect(Math.max(...mesh.sway)).toBeLessThanOrEqual(1);
    }
  });

  it('maps tiers to a lower detail on weaker tiers', () => {
    expect(EUPHYLLIA_DETAIL.low).toBeLessThan(EUPHYLLIA_DETAIL.medium);
    expect(EUPHYLLIA_DETAIL.medium).toBeLessThan(EUPHYLLIA_DETAIL.high);
  });
});

describe('euphyllia placement data', () => {
  const mesh = generateEuphyllia('torch', 3, 1);

  it('exports a soft capsule that covers the colony from the foot', () => {
    const collider = euphylliaCollider(mesh.bounds, item);
    expect(collider.hard).toBe(false);
    expect(collider.a[1]).toBeGreaterThanOrEqual(item.position[1]);
    expect(collider.b[1]).toBeGreaterThanOrEqual(collider.a[1]);
    expect(collider.b[1]).toBeLessThanOrEqual(item.position[1] + mesh.bounds.max[1]);
  });

  it('reaches further in a stronger current', () => {
    const calm = { direction: [1, 0] as const, speed: 0.02, gustPeriodS: 8, gustDepth: 0.2 };
    const brisk = { ...calm, speed: 0.1, gustDepth: 0.5 };
    expect(euphylliaReach(mesh.bounds, item, brisk)).toBeGreaterThan(
      euphylliaReach(mesh.bounds, item, calm),
    );
  });
});

describe('euphyllia meander reach', () => {
  it('adds the sideways meander to the ambient lean', () => {
    const tall: EuphylliaMesh['bounds'] = { min: [-0.1, 0, -0.1], max: [0.1, 10, 0.1] };
    const still = { direction: [1, 0] as const, speed: 0, gustPeriodS: 8, gustDepth: 0 };
    const gusty = { ...still, speed: 0.05, gustDepth: 0.5 };
    const flowOnly = gusty.speed * (1 + gusty.gustDepth) * LEAN_SECONDS;
    const extra = euphylliaReach(tall, item, gusty) - euphylliaReach(tall, item, still);
    expect(extra).toBeGreaterThan(flowOnly * item.scale - 1e-9 + 1e-6);
  });
});

describe('euphyllia glass reach', () => {
  it('counts a rotated corner, not just the largest single-axis extent', () => {
    const bounds: EuphylliaMesh['bounds'] = { min: [-0.1, 0, -0.1], max: [0.1, 0.1, 0.1] };
    const still = { direction: [1, 0] as const, speed: 0, gustPeriodS: 8, gustDepth: 0 };
    const rotated = { ...item, rotationY: Math.PI / 4, scale: 1 };
    expect(euphylliaReach(bounds, rotated, still)).toBeGreaterThanOrEqual(Math.hypot(0.1, 0.1));
  });
});
