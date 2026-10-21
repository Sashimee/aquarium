import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import {
  CRAB_KIND,
  HERMIT_RECIPES,
  assignLimbIndices,
  limbReach,
  clusterByDirection,
  crabColour,
  recolourDense,
  segmentCrab,
} from './hermit.ts';
import { canonicalVertices } from './crew-scan.ts';
import {
  FIN_ID_ATTRIBUTE,
  FIN_MASK_ATTRIBUTE,
  LEG_ATTRIBUTE,
  SHRIMP_PART_IDS,
} from './index-schema.ts';
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

describe('limbReach', () => {
  const positions = [0, 0, 0, 0, 0, 3, 0, 0, 4];
  it('measures root to tip', () => {
    expect(limbReach(positions, [0, 1, 2], [0, 0.5, 1])).toBeCloseTo(4);
  });

  it('throws on a piece without root or tip vertices', () => {
    expect(() => limbReach(positions, [0, 1], [0, 0.5, 1])).toThrow(/limbReach/);
    expect(() => limbReach(positions, [1, 2], [0, 0.5, 1])).toThrow(/limbReach/);
  });
});

describe('assignLimbIndices', () => {
  it('ranks legs fore to aft on their own side, so a side with fewer legs does not shift the other', () => {
    const index = assignLimbIndices([
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 3, reach: 1 },
      { kind: CRAB_KIND.leg, lateral: 1, ahead: 2.9, reach: 1 },
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 1, reach: 3 },
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 2, reach: 3 },
    ]);
    expect(index).toEqual([0, 1, 4, 2]);
  });

  it('puts the shortest-reach leg of each side in pair 0 even when it sits behind the walking legs', () => {
    const index = assignLimbIndices([
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 3, reach: 7 },
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 1, reach: 3 },
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 2, reach: 7 },
      { kind: CRAB_KIND.leg, lateral: 1, ahead: 3, reach: 7 },
      { kind: CRAB_KIND.leg, lateral: 1, ahead: 2, reach: 7 },
      { kind: CRAB_KIND.leg, lateral: 1, ahead: 1, reach: 3.2 },
    ]);
    expect(index).toEqual([2, 0, 4, 3, 5, 1]);
  });

  it('throws when the two sides claws do not look alike', () => {
    expect(() =>
      assignLimbIndices([
        { kind: CRAB_KIND.leg, lateral: -1, ahead: 2, reach: 3 },
        { kind: CRAB_KIND.leg, lateral: -1, ahead: 1, reach: 7 },
        { kind: CRAB_KIND.leg, lateral: 1, ahead: 2, reach: 7 },
        { kind: CRAB_KIND.leg, lateral: 1, ahead: 1, reach: 8 },
      ]),
    ).toThrow(/claws differ/);
  });

  it('keeps indices unique when several legs share a rank and maps antennae to the 2/3 slot', () => {
    const index = assignLimbIndices([
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 3, reach: 1 },
      { kind: CRAB_KIND.leg, lateral: -1, ahead: 2, reach: 1 },
      { kind: CRAB_KIND.antenna, lateral: -0.5, ahead: 4, reach: 1 },
      { kind: CRAB_KIND.antenna, lateral: 0.5, ahead: 4, reach: 1 },
    ]);
    expect(index[0]).not.toBe(index[1]);
    expect(index.slice(2)).toEqual([2, 3]);
  });

  it('caps the pair index at four pairs and gives non-limb pieces -1', () => {
    const legs = Array.from({ length: 7 }, (_, i) => ({
      kind: CRAB_KIND.leg,
      lateral: -1,
      ahead: 7 - i,
      reach: 1 + i,
    }));
    const index = assignLimbIndices([
      ...legs,
      { kind: CRAB_KIND.stem, lateral: 0, ahead: 0, reach: 0 },
    ]);
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

describe('clusterByDirection', () => {
  it('parts points that fan out from the hip by direction, whatever their distance', () => {
    const points: Vec3[] = [];
    for (const [dx, dz] of [
      [1, 0],
      [0.7, 0.7],
      [0, 1],
    ] as const)
      for (let r = 1; r <= 10; r++) points.push([dx * r, 0, dz * r]);
    const label = clusterByDirection(points, [0, 0, 0], 3);
    expect(new Set(label).size).toBe(3);
    for (let leg = 0; leg < 3; leg++)
      expect(new Set(label.slice(leg * 10, leg * 10 + 10)).size).toBe(1);
  });
});

describe('the shipped hermit crab', () => {
  const assets = fileURLToPath(new URL('../../../apps/web/public/assets', import.meta.url));

  interface ShippedLegs {
    position: ArrayLike<number>;
    part: ArrayLike<number>;
    leg: ArrayLike<number>;
    weight: ArrayLike<number>;
    indices: ArrayLike<number>;
  }

  async function readCrab(level: number): Promise<ShippedLegs> {
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const doc = await io.read(join(assets, 'crab', 'hermit-crab', `lod${level}.glb`));
    const prims = doc
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives());
    expect(prims).toHaveLength(1);
    const prim = prims[0]!;
    return {
      position: prim.getAttribute('POSITION')!.getArray()!,
      part: prim.getAttribute(FIN_ID_ATTRIBUTE)!.getArray()!,
      leg: prim.getAttribute(LEG_ATTRIBUTE)!.getArray()!,
      weight: prim.getAttribute(FIN_MASK_ATTRIBUTE)!.getArray()!,
      indices: prim.getIndices()!.getArray()!,
    };
  }

  const isLeg = (crab: ShippedLegs, v: number): boolean => crab.part[v] === SHRIMP_PART_IDS.leg;

  it('gives each of its three legs a side its own slot, walking legs front to back', async () => {
    const crab = await readCrab(0);
    const slots = new Map<number, { x: number; z: number; count: number }>();
    for (let v = 0; v < crab.part.length; v++) {
      if (!isLeg(crab, v)) continue;
      const slot = slots.get(crab.leg[v]!) ?? { x: 0, z: 0, count: 0 };
      slot.x += crab.position[v * 3]!;
      slot.z += crab.position[v * 3 + 2]!;
      slot.count++;
      slots.set(crab.leg[v]!, slot);
    }
    expect([...slots.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const slot of slots.values()) expect(slot.count).toBeGreaterThan(200);
    const mean = (slot: number, axis: 'x' | 'z'): number =>
      slots.get(slot)![axis] / slots.get(slot)!.count;
    for (const side of [0, 1]) {
      expect(mean(side + 2, 'z')).toBeGreaterThan(mean(side + 4, 'z'));
    }
    for (const pair of [0, 2, 4]) expect(mean(pair, 'x')).toBeLessThan(mean(pair + 1, 'x'));
  });

  it.each([0, 1, 2])(
    'LOD%i: slots 0 and 1 are the claws, shorter than every walking leg and alike',
    async (level) => {
      const crab = await readCrab(level);
      const sums = new Map<number, { root: number[]; tip: number[]; r: number; t: number }>();
      for (let v = 0; v < crab.part.length; v++) {
        if (!isLeg(crab, v)) continue;
        const entry = sums.get(crab.leg[v]!) ?? { root: [0, 0, 0], tip: [0, 0, 0], r: 0, t: 0 };
        const w = crab.weight[v]!;
        const into = w < 0.1 ? entry.root : w > 0.9 ? entry.tip : null;
        if (into) {
          for (let a = 0; a < 3; a++) into[a]! += crab.position[v * 3 + a]!;
          if (w < 0.1) entry.r++;
          else entry.t++;
        }
        sums.set(crab.leg[v]!, entry);
      }
      const reach = (slot: number): number => {
        const e = sums.get(slot)!;
        return Math.hypot(...[0, 1, 2].map((a) => e.root[a]! / e.r - e.tip[a]! / e.t));
      };
      for (const claw of [0, 1])
        for (const walker of [2, 3, 4, 5])
          expect(reach(claw), `slot ${claw} vs ${walker}`).toBeLessThan(reach(walker));
      expect(Math.max(reach(0), reach(1)) / Math.min(reach(0), reach(1))).toBeLessThan(1.5);
    },
  );

  it.each([0, 1, 2])(
    'LOD%i: every leg slot is one connected piece whose root touches the body',
    async (level) => {
      const crab = await readCrab(level);
      const canon = canonicalVertices(crab.position, 1e-7);
      const parent = new Map<number, number>();
      const find = (a: number): number => {
        let root = a;
        while (parent.get(root) !== root) root = parent.get(root)!;
        return root;
      };
      const slotOf = new Map<number, number>();
      for (let v = 0; v < crab.part.length; v++)
        if (isLeg(crab, v)) {
          parent.set(canon[v]!, canon[v]!);
          slotOf.set(canon[v]!, crab.leg[v]!);
        }
      const rooted = new Set<number>();
      for (let t = 0; t < crab.indices.length; t += 3)
        for (let k = 0; k < 3; k++) {
          const a = crab.indices[t + k]!;
          const b = crab.indices[t + ((k + 1) % 3)]!;
          if (isLeg(crab, a) && isLeg(crab, b) && crab.leg[a] === crab.leg[b])
            parent.set(find(canon[a]!), find(canon[b]!));
          else if (isLeg(crab, a) !== isLeg(crab, b)) {
            const leg = isLeg(crab, a) ? a : b;
            const other = leg === a ? b : a;
            if (crab.part[other] === SHRIMP_PART_IDS.abdomen) rooted.add(canon[leg]!);
          }
        }
      const pieces = new Map<number, Map<number, { size: number; touchesBody: boolean }>>();
      for (const [node, slot] of slotOf) {
        const bySlot = pieces.get(slot) ?? new Map();
        const piece = bySlot.get(find(node)) ?? { size: 0, touchesBody: false };
        piece.size++;
        piece.touchesBody ||= rooted.has(node);
        bySlot.set(find(node), piece);
        pieces.set(slot, bySlot);
      }
      expect([...pieces.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
      for (const [slot, bySlot] of pieces) {
        const real = [...bySlot.values()].filter((p) => p.size > 5);
        expect(real, `slot ${slot}`).toHaveLength(1);
        expect(real[0]!.touchesBody, `slot ${slot} root`).toBe(true);
      }
    },
  );
});
