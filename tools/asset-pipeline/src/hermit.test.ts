import { describe, expect, it } from 'vitest';
import {
  CRAB_KIND,
  HERMIT_RECIPES,
  assignLimbIndices,
  crabColour,
  recolourDense,
  segmentCrab,
} from './hermit.ts';
import type { Vec3 } from './math.ts';
import type { Dense } from './rebake.ts';

interface Mesh {
  positions: number[];
  indices: number[];
}

function sphere(centre: Vec3, radius: number, rings = 48, segments = 64): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r++)
    for (let k = 0; k < segments; k++) {
      const phi = (r / rings) * Math.PI;
      const theta = (k / segments) * Math.PI * 2;
      positions.push(
        centre[0] + radius * Math.sin(phi) * Math.cos(theta),
        centre[1] + radius * Math.cos(phi),
        centre[2] + radius * Math.sin(phi) * Math.sin(theta),
      );
    }
  for (let r = 0; r < rings; r++)
    for (let k = 0; k < segments; k++) {
      const a = r * segments + k;
      const b = r * segments + ((k + 1) % segments);
      indices.push(a, a + segments, b, b, a + segments, b + segments);
    }
  return { positions, indices };
}

function tube(from: Vec3, to: Vec3, radius: number, steps = 12, sides = 12): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const axis = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(...axis);
  const w = axis.map((v) => v / length);
  const helper = Math.abs(w[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = [
    w[1]! * helper[2]! - w[2]! * helper[1]!,
    w[2]! * helper[0]! - w[0]! * helper[2]!,
    w[0]! * helper[1]! - w[1]! * helper[0]!,
  ];
  const un = Math.hypot(...u);
  const uu = u.map((v) => v / un);
  const v = [
    w[1]! * uu[2]! - w[2]! * uu[1]!,
    w[2]! * uu[0]! - w[0]! * uu[2]!,
    w[0]! * uu[1]! - w[1]! * uu[0]!,
  ];
  for (let s = 0; s <= steps; s++)
    for (let k = 0; k < sides; k++) {
      const angle = (k / sides) * Math.PI * 2;
      for (let a = 0; a < 3; a++)
        positions.push(
          from[a]! +
            w[a]! * length * (s / steps) +
            radius * (Math.cos(angle) * uu[a]! + Math.sin(angle) * v[a]!),
        );
    }
  for (let s = 0; s < steps; s++)
    for (let k = 0; k < sides; k++) {
      const a = s * sides + k;
      const b = s * sides + ((k + 1) % sides);
      indices.push(a, a + sides, b, b, a + sides, b + sides);
    }
  for (const [ringStart, point, reversed] of [
    [0, from, true],
    [steps * sides, to, false],
  ] as const) {
    const centre = positions.length / 3;
    positions.push(...point);
    for (let k = 0; k < sides; k++) {
      const a = ringStart + k;
      const b = ringStart + ((k + 1) % sides);
      indices.push(...(reversed ? [centre, b, a] : [centre, a, b]));
    }
  }
  return { positions, indices };
}

function merge(meshes: Mesh[]): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of meshes) {
    const base = positions.length / 3;
    positions.push(...mesh.positions);
    indices.push(...mesh.indices.map((i) => i + base));
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

const OPTIONS = {
  voxelFraction: 1 / 60,
  bodyOpeningFraction: 0.18,
  thinOpeningFraction: 0.04,
  crabZFraction: 0.55,
  limbCutFraction: 0.35,
  minPieceReach: 0.15,
};

describe('segmentCrab', () => {
  const scan = merge([
    sphere([0, 0, -1], 1),
    tube([0, 0, -0.3], [0, 0, 0.9], 0.3, 36, 24),
    tube([0.5, 0, 0.5], [1.4, -0.3, 1.6], 0.22),
    tube([-0.5, 0, 0.5], [-1.4, -0.3, 1.6], 0.22),
    tube([0, 0.1, 0.9], [0.1, 0.9, 1.8], 0.05, 16, 8),
  ]);
  const result = segmentCrab(scan.positions, scan.indices, OPTIONS);

  it('keeps the bulky sphere as shell and finds the limbs beyond it', () => {
    const count = scan.positions.length / 3;
    for (let i = 0; i < 49 * 64; i++) expect(result.kind[i]).toBe(CRAB_KIND.shell);
    expect(result.kind.length).toBe(count);
    const kinds = result.pieces.map((p) => p.kind);
    expect(kinds.filter((k) => k === CRAB_KIND.leg).length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain(CRAB_KIND.antenna);
  });

  it('puts a leg on each side and the antenna above', () => {
    const legs = result.pieces.filter((p) => p.kind === CRAB_KIND.leg);
    expect(legs.some((p) => p.centroid[0] > 0.3)).toBe(true);
    expect(legs.some((p) => p.centroid[0] < -0.3)).toBe(true);
    const antenna = result.pieces.find((p) => p.kind === CRAB_KIND.antenna)!;
    expect(antenna.centroid[1]).toBeGreaterThan(0.2);
  });

  it('weights limbs from the root to the tip inside [0, 1] and leaves the shell at 0', () => {
    for (let i = 0; i < result.weight.length; i++) {
      expect(result.weight[i]).toBeGreaterThanOrEqual(0);
      expect(result.weight[i]).toBeLessThanOrEqual(1);
      if (result.kind[i] === CRAB_KIND.shell) expect(result.piece[i]).toBe(-1);
    }
    const legTip = result.pieces.findIndex((p) => p.kind === CRAB_KIND.leg);
    const weights = Array.from(result.piece, (p, i) =>
      p === legTip ? result.weight[i]! : -1,
    ).filter((w) => w >= 0);
    expect(Math.max(...weights)).toBeCloseTo(1, 5);
    expect(Math.min(...weights)).toBeCloseTo(0, 5);
  });

  it('places the hip between the shell and the limbs', () => {
    expect(result.hip[2]).toBeGreaterThan(result.shellCentroid[2]);
  });

  it('fails loudly when no crab touches the shell', () => {
    const lone = merge([sphere([0, 0, -1], 1), tube([4, 0, 3], [4, 0, 5], 0.3)]);
    expect(() => segmentCrab(lone.positions, lone.indices, OPTIONS)).toThrow(
      /does not touch the shell/,
    );
  });
});

describe('assignLimbIndices', () => {
  it('gives the frontmost legs the lowest pair and alternates sides by lateral sign', () => {
    const index = assignLimbIndices([
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 3 },
      { kind: CRAB_KIND.leg, lateral: 1, ahead: 2.9 },
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 1 },
    ]);
    expect(index).toEqual([0, 3, 4]);
  });

  it('keeps indices unique when several legs share a rank and maps antennae to the 2/3 slot', () => {
    const index = assignLimbIndices([
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 3 },
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 2 },
      { kind: CRAB_KIND.antenna, lateral: -0.5, ahead: 4 },
      { kind: CRAB_KIND.antenna, lateral: 0.5, ahead: 4 },
    ]);
    expect(index[0]).not.toBe(index[1]);
    expect(index.slice(2)).toEqual([2, 3]);
  });

  it('caps the pair index at four pairs and gives non-limb pieces -1', () => {
    const legs = Array.from({ length: 7 }, (_, i) => ({
      kind: CRAB_KIND.leg,
      lateral: -1,
      ahead: 7 - i,
    }));
    const index = assignLimbIndices([...legs, { kind: CRAB_KIND.stem, lateral: 0, ahead: 0 }]);
    expect(new Set(index.slice(0, 7)).size).toBe(7);
    expect(index[7]).toBe(-1);
  });
});

describe('crabColour', () => {
  it('colours stems and antennae flat and legs blue with orange joints and a dark tip', () => {
    expect(crabColour(CRAB_KIND.stem, 0.5)).toEqual(crabColour(CRAB_KIND.stem, 0.9));
    expect(crabColour(CRAB_KIND.antenna, 0.2)[0]).toBeGreaterThan(
      crabColour(CRAB_KIND.antenna, 0.2)[2],
    );
    const blue = crabColour(CRAB_KIND.leg, 0.05);
    expect(blue[2]).toBeGreaterThan(blue[0]);
    const ring = crabColour(CRAB_KIND.leg, 0.19);
    expect(ring[0]).toBeGreaterThan(ring[2]);
    const tip = crabColour(CRAB_KIND.leg, 0.99);
    expect(Math.max(...tip)).toBeLessThan(0.1);
  });
});

describe('recolourDense', () => {
  function dense(colours: number[]): Dense {
    const count = colours.length / 3;
    return {
      positions: new Float32Array(count * 3),
      indices: new Uint32Array(0),
      colours: Float32Array.from(colours),
      extra: {},
    };
  }

  it('recolours stem vertices, keeps shell vertices and preserves relative shading', () => {
    const d = dense([0.5, 0.5, 0.5, 0.78, 0.78, 0.78, 0.24, 0.24, 0.24, 0.3, 0.2, 0.1]);
    const kind = Uint8Array.from([
      CRAB_KIND.shell,
      CRAB_KIND.stem,
      CRAB_KIND.stem,
      CRAB_KIND.shell,
    ]);
    recolourDense(d, kind, new Float32Array(4));
    expect(Array.from(d.colours.slice(0, 3))).toEqual([0.5, 0.5, 0.5].map((v) => Math.fround(v)));
    expect(Array.from(d.colours.slice(9, 12))).toEqual([0.3, 0.2, 0.1].map((v) => Math.fround(v)));
    expect(d.colours[3]!).toBeGreaterThan(d.colours[6]!);
    expect(d.colours[3]!).toBeGreaterThan(d.colours[4]!);
  });

  it('colours legs by their weight along the limb', () => {
    const d = dense([0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
    recolourDense(
      d,
      Uint8Array.from([CRAB_KIND.leg, CRAB_KIND.leg]),
      Float32Array.from([0.05, 0.99]),
    );
    expect(d.colours[2]!).toBeGreaterThan(d.colours[0]!);
    expect(Math.max(d.colours[3]!, d.colours[4]!, d.colours[5]!)).toBeLessThan(0.1);
  });
});

describe('HERMIT_RECIPES', () => {
  it('defines a recipe with a positive size budget', () => {
    for (const recipe of HERMIT_RECIPES) {
      expect(recipe.maxTriangles).toBeGreaterThan(0);
      expect(recipe.maxTriangles).toBeLessThanOrEqual(15000);
      expect(recipe.fallbackLengthM).toBeGreaterThan(0);
    }
  });
});
