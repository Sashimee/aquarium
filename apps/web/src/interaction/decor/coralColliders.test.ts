import type { Collider, Coral } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { TANK_DIMENSIONS } from '../../engine/tank/dimensions';
import catalog from '../../../public/assets/index.json';
import { growCorals, type CoralColliderInput } from './coralColliders';
import { collidersFor } from './colliders';
import { flat, item, must, SPECS, spec } from './fixtures';
import { numberPieces } from './layout';

const bounds = new Map(
  catalog.assets.flatMap((a) =>
    'bounds' in a && a.bounds
      ? [
          [
            a.id,
            {
              min: a.bounds.min as [number, number, number],
              max: a.bounds.max as [number, number, number],
            },
          ] as const,
        ]
      : [],
  ),
);
const CALM = {
  pumpMps: 0.3,
  direction: [1, 0] as const,
  speed: 0.04,
  gustPeriodS: 9,
  gustDepth: 0.4,
};
const EUPHYLLIA = 'euphyllia-hammer-12';
const euphylliaBounds: { min: [number, number, number]; max: [number, number, number] } = {
  min: [-0.06, 0, -0.06],
  max: [0.06, 0.1, 0.06],
};

const coral = (over: Partial<Coral> = {}): Coral => ({
  key: 's7',
  assetId: 'acropora-cytherea',
  tintSeed: 7,
  parentKey: null,
  position: null,
  size: 1,
  minSize: 0.4,
  maxSize: 3,
  fragMinSize: 1.5,
  bleach: 0,
  ...over,
});

function input(over: Partial<CoralColliderInput> = {}): CoralColliderInput {
  return {
    pieces: numberPieces([item('acropora-cytherea', 0, 0, { tintSeed: 7 })]),
    fixed: [],
    specs: SPECS,
    corals: [],
    dimensions: TANK_DIMENSIONS.standard,
    current: CALM,
    ground: flat,
    boundsOf: (id) => (id === EUPHYLLIA ? euphylliaBounds : (bounds.get(id) ?? null)),
    ...over,
  };
}

const halfWidth = (colliders: readonly Collider[], id: string): number => {
  const found = must(colliders.find((c) => c.id === id));
  if (found.kind !== 'box') throw new Error(`${id} is not a box`);
  return found.halfExtents[0];
};

const piecesToColliders = (pieces: ReturnType<typeof growCorals>['pieces']): Collider[] =>
  pieces.flatMap((p) => collidersFor(`${p.id}`, spec(p.item.assetId), p.item));

describe('growCorals', () => {
  it('changes nothing without coral state', () => {
    const grown = growCorals(input());
    expect(grown.pieces).toEqual(input().pieces);
    expect(grown.extra).toEqual([]);
  });

  it('makes a grown colony collide at its grown size', () => {
    const placed = halfWidth(piecesToColliders(growCorals(input()).pieces), 'decor:p1');
    const grown = halfWidth(
      piecesToColliders(growCorals(input({ corals: [coral({ size: 1.6 })] })).pieces),
      'decor:p1',
    );
    expect(grown).toBeCloseTo(placed * 1.6, 5);
  });

  it('follows the colony as it keeps growing and as it is fragged smaller', () => {
    const widths = [0.5, 1, 1.4, 2].map((size) =>
      halfWidth(
        piecesToColliders(growCorals(input({ corals: [coral({ size })] })).pieces),
        'decor:p1',
      ),
    );
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(new Set(widths).size).toBe(4);
  });

  it('holds growth to the glass', () => {
    const near = item('acropora-cytherea', 0.35, 0, { tintSeed: 7 });
    const grown = growCorals(
      input({ pieces: numberPieces([near]), corals: [coral({ size: 3 })] }),
    ).pieces;
    const scale = must(grown[0]).item.scale;
    expect(scale).toBeGreaterThan(near.scale);
    expect(scale).toBeLessThan(3);
    const glassHalfLength = TANK_DIMENSIONS.standard.length / 2 - TANK_DIMENSIONS.standard.glass;
    const edge = 0.35 + must(bounds.get('acropora-cytherea')).max[0] * scale;
    expect(edge).toBeLessThanOrEqual(glassHalfLength);
  });

  it('holds a euphyllia further from the glass in a stronger current', () => {
    const near = item(EUPHYLLIA, 0.3, 0, { tintSeed: 7 });
    const scaleIn = (current: CoralColliderInput['current']): number => {
      const { extra } = growCorals(
        input({
          pieces: [],
          fixed: [near],
          corals: [coral({ assetId: EUPHYLLIA, size: 3 })],
          current,
        }),
      );
      const capsule = must(extra.find((c) => c.id === 'decor:coral:s7'));
      if (capsule.kind !== 'capsule') throw new Error('expected a capsule');
      return capsule.radius;
    };
    const still = scaleIn({ ...CALM, speed: 0 });
    const strong = scaleIn({ ...CALM, speed: 0.1, pumpMps: 0.6 });
    expect(strong).toBeLessThan(still);
  });

  it('leaves a piece with no matching coral alone', () => {
    const grown = growCorals(input({ corals: [coral({ key: 's99', tintSeed: 99, size: 2 })] }));
    expect(must(grown.pieces[0]).item.scale).toBe(1);
  });

  it('stands a collider on each fragment, away from the colony', () => {
    const frag = coral({
      key: 's7.1',
      parentKey: 's7',
      position: [0.2, 0.1],
      size: 0.3,
    });
    const { extra } = growCorals(input({ corals: [coral(), frag] }));
    const box = must(extra.find((c) => c.id === 'decor:coral:s7.1'));
    expect(box.kind).toBe('box');
    if (box.kind === 'box') {
      expect(box.center[0]).toBeGreaterThan(0.1);
      expect(box.halfExtents[0]).toBeGreaterThan(0);
    }
  });

  it('grows a fragment with its own size', () => {
    const at = (size: number) =>
      halfWidth(
        growCorals(
          input({
            corals: [coral(), coral({ key: 's7.1', parentKey: 's7', position: [0.2, 0.1], size })],
          }),
        ).extra,
        'decor:coral:s7.1',
      );
    expect(at(1.2)).toBeGreaterThan(at(0.3));
  });

  it('skips a fragment whose colony is not in the layout', () => {
    const { extra } = growCorals(
      input({
        corals: [
          coral({ key: 's99', tintSeed: 99, size: 1 }),
          coral({ key: 's99.1', parentKey: 's99', position: [0.2, 0.1], size: 0.3 }),
        ],
      }),
    );
    expect(extra).toEqual([]);
  });

  it('adds a soft collider for a procedural coral that grew, and none while unchanged', () => {
    const fixed = [item(EUPHYLLIA, -0.3, 0, { tintSeed: 4 })];
    const base = { assetId: EUPHYLLIA, tintSeed: 4, key: 's4' };
    const unchanged = growCorals(
      input({ pieces: [], fixed, corals: [coral({ ...base, size: 1 })] }),
    );
    expect(unchanged.extra).toEqual([]);
    const grown = growCorals(input({ pieces: [], fixed, corals: [coral({ ...base, size: 1.5 })] }));
    const capsule = must(grown.extra.find((c) => c.id === 'decor:coral:s4'));
    expect(capsule.kind).toBe('capsule');
    expect(capsule.hard).toBe(false);
  });
});
