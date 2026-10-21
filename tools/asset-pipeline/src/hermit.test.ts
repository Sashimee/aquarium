import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import {
  CRAB_KIND,
  HERMIT_RECIPES,
  assertClawsOpposite,
  assignLimbIndices,
  clusterByDirection,
  crabColour,
  groundWalkers,
  limbEnds,
  limbReach,
  recolourDense,
  segmentCrab,
  shellTrailYaw,
  type LimbFrame,
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
  voxelFraction: 1 / 90,
  trunkOpeningFraction: 0.1,
  trunkMarginFraction: 0.05,
  thinOpeningFraction: 0.012,
  minPieceReach: 0.15,
};

describe('segmentCrab', () => {
  const crab = merge([
    sphere([0, 0, 0], 1),
    tube([0.8, 0, 0.3], [2, 0, 1.5], 0.15),
    tube([-0.8, 0, 0.3], [-2, 0, 1.5], 0.15),
    tube([0, 0.5, 0.8], [0.1, 1.6, 2.2], 0.02, 16, 8),
  ]);
  const result = segmentCrab(crab.positions, crab.indices, OPTIONS);

  it('keeps the bulky body as the trunk and finds a leg each side and the antenna', () => {
    const sphereVertices = 49 * 64;
    for (let i = 0; i < sphereVertices; i++) {
      expect(result.kind[i]).toBe(CRAB_KIND.stem);
      expect(result.piece[i]).toBe(-1);
    }
    const legs = result.pieces.filter((p) => p.kind === CRAB_KIND.leg);
    expect(legs).toHaveLength(2);
    expect(legs.some((p) => p.centroid[0] > 1)).toBe(true);
    expect(legs.some((p) => p.centroid[0] < -1)).toBe(true);
    const antennae = result.pieces.filter((p) => p.kind === CRAB_KIND.antenna);
    expect(antennae).toHaveLength(1);
    expect(antennae[0]!.centroid[1]).toBeGreaterThan(0.8);
  });

  it('weights each limb 0 at its root to 1 at its tip', () => {
    for (let i = 0; i < result.weight.length; i++) {
      expect(result.weight[i]).toBeGreaterThanOrEqual(0);
      expect(result.weight[i]).toBeLessThanOrEqual(1);
    }
    result.pieces.forEach((_, piece) => {
      const weights = Array.from(result.piece, (p, i) =>
        p === piece ? result.weight[i]! : -1,
      ).filter((w) => w >= 0);
      expect(Math.max(...weights)).toBeCloseTo(1, 5);
      expect(Math.min(...weights)).toBeCloseTo(0, 5);
    });
  });

  it('places the hip inside the trunk', () => {
    for (const c of result.hip) expect(Math.abs(c)).toBeLessThan(0.3);
  });

  it('fails loudly when no trunk survives the opening', () => {
    expect(() =>
      segmentCrab(crab.positions, crab.indices, { ...OPTIONS, trunkOpeningFraction: 2 }),
    ).toThrow(/no trunk survives/);
  });
});

describe('limbEnds and limbReach', () => {
  const positions = [0, 0, 0, 0, 0, 3, 0, 0, 4];
  it('measures root to tip', () => {
    expect(limbEnds(positions, [0, 1, 2], [0, 0.5, 1])).toEqual({
      root: [0, 0, 0],
      tip: [0, 0, 4],
    });
    expect(limbReach(positions, [0, 1, 2], [0, 0.5, 1])).toBeCloseTo(4);
  });

  it('throws on a piece without root or tip vertices', () => {
    expect(() => limbReach(positions, [0, 1], [0, 0.5, 1])).toThrow(/limbEnds/);
    expect(() => limbReach(positions, [1, 2], [0, 0.5, 1])).toThrow(/limbEnds/);
  });
});

const leg = (lateral: number, ahead: number, rootAhead: number, reach = 1): LimbFrame => ({
  kind: CRAB_KIND.leg,
  lateral,
  ahead,
  rootAhead,
  reach,
});

describe('assignLimbIndices', () => {
  it('gives the foremost root on each side pair 0 and ranks the walkers fore to aft on their side', () => {
    const index = assignLimbIndices([
      leg(-1, 3, 3),
      leg(1, 3, 3),
      leg(-1, 1, 0.5),
      leg(-1, 2, 1),
      leg(1, 2, 1),
    ]);
    expect(index).toEqual([0, 1, 4, 2, 3]);
  });

  it('picks the claw per side, so a walking leg may root ahead of the other sides claw', () => {
    const index = assignLimbIndices([
      leg(-0.1, 0.57, 0.42, 0.33),
      leg(0.3, 0.52, 0.35, 0.33),
      leg(-0.5, 0.6, 0.38, 0.5),
      leg(0.5, 0.42, 0.28, 0.5),
    ]);
    expect(index).toEqual([0, 1, 2, 3]);
  });

  it('allows the real left and right claw asymmetry up to 4:1 and no further', () => {
    const pair = (right: number): LimbFrame[] => [
      leg(-1, 3, 3, 1),
      leg(1, 3, 3, right),
      leg(-1, 1, 0.5),
      leg(1, 1, 0.5),
    ];
    expect(assignLimbIndices(pair(4))).toEqual([0, 1, 2, 3]);
    expect(() => assignLimbIndices(pair(4.5))).toThrow(/claws differ/);
  });

  it('throws when a claw root does not lead the walking legs on its side', () => {
    expect(() =>
      assignLimbIndices([leg(-1, 3, 1), leg(1, 3, 3), leg(-1, 2, 1), leg(1, 2, 1)]),
    ).toThrow(/leads the foremost walking leg/);
  });

  it('throws when a side has no leg or there is no walking leg', () => {
    expect(() => assignLimbIndices([leg(-1, 3, 3), leg(-1, 2, 1)])).toThrow(/no leg piece/);
    expect(() => assignLimbIndices([leg(-1, 3, 3), leg(1, 3, 3)])).toThrow(/walking leg/);
  });

  it('keeps indices unique past four pairs, sends antennae to 2/3 and non-limbs to -1', () => {
    const index = assignLimbIndices([
      leg(-1, 9, 9),
      leg(-1, 8, 1),
      leg(-1, 7, 1),
      leg(-1, 6, 1),
      leg(-1, 5, 1),
      leg(-1, 4, 1),
      leg(1, 9, 9),
      leg(1, 8, 1),
      { kind: CRAB_KIND.antenna, lateral: -0.5, ahead: 4, rootAhead: 4, reach: 1 },
      { kind: CRAB_KIND.antenna, lateral: 0.5, ahead: 4, rootAhead: 4, reach: 1 },
      { kind: CRAB_KIND.stem, lateral: 0, ahead: 0, rootAhead: 0, reach: 0 },
    ]);
    expect(new Set(index.slice(0, 8)).size).toBe(8);
    expect(index.slice(8)).toEqual([2, 3, -1]);
  });
});

describe('assertClawsOpposite', () => {
  const legs = [leg(-1, 3, 3), leg(-0.5, 2.5, 2.8), leg(1, 2, 2.6), leg(-1, 1, 1)];
  const byRoot = [...legs].sort((a, b) => b.rootAhead - a.rootAhead);

  it('accepts one claw on each side, the -x one first', () => {
    expect(() => assertClawsOpposite([legs[0]!, legs[2]!])).not.toThrow();
  });

  it('fails the global-order pick, which takes the two foremost roots whatever their side', () => {
    expect(() => assertClawsOpposite([byRoot[0]!, byRoot[1]!])).toThrow(/not global order/);
  });

  it('fails a swapped pair and a pair on one side', () => {
    expect(() => assertClawsOpposite([legs[2]!, legs[0]!])).toThrow(/assertClawsOpposite/);
    expect(() => assertClawsOpposite([legs[1]!, legs[3]!])).toThrow(/assertClawsOpposite/);
  });

  it('keeps assignLimbIndices on the per-side pick for the same legs', () => {
    expect(assignLimbIndices(legs)).toEqual([0, 2, 1, 4]);
  });
});

describe('groundWalkers', () => {
  const standoff = 0.01;
  const verts = (tipY: number): Float32Array =>
    Float32Array.from([0, -0.002, 0, 0, -0.005, 0.01, 0, tipY, 0.02]);
  const kind = [CRAB_KIND.leg, CRAB_KIND.leg, CRAB_KIND.leg];
  const weight = [0, 0.5, 1];

  it('brings a hovering walking leg tip to the ground and leaves its root alone', () => {
    const positions = verts(-0.006);
    groundWalkers(positions, kind, [2, 2, 2], weight, standoff);
    expect(positions[1]).toBe(Math.fround(-0.002));
    expect(positions[7]).toBeCloseTo(-standoff, 6);
    expect(positions[4]!).toBeLessThan(-0.005);
  });

  it('leaves claws, antennae and a leg already on the ground untouched', () => {
    const claw = verts(-0.006);
    groundWalkers(claw, kind, [0, 0, 0], weight, standoff);
    expect(Array.from(claw)).toEqual(Array.from(verts(-0.006)));
    const antenna = verts(-0.006);
    groundWalkers(antenna, [7, 7, 7], [2, 2, 2], weight, standoff);
    expect(Array.from(antenna)).toEqual(Array.from(verts(-0.006)));
    const down = verts(-standoff);
    groundWalkers(down, kind, [3, 3, 3], weight, standoff);
    expect(Array.from(down)).toEqual(Array.from(verts(-standoff)));
  });

  it('reaches the ground when the lowest vertex is short of the limb tip', () => {
    const positions = Float32Array.from([0, -0.002, 0, 0, -0.007, 0.01, 0, -0.004, 0.02]);
    groundWalkers(positions, kind, [2, 2, 2], [0, 0.6, 1], standoff);
    expect(Math.min(positions[1]!, positions[4]!, positions[7]!)).toBeCloseTo(-standoff, 4);
  });
});

describe('shellTrailYaw', () => {
  const rotate = (pts: Array<[number, number]>, yaw: number): Array<[number, number]> =>
    pts.map(([x, z]) => [
      x * Math.cos(yaw) + z * Math.sin(yaw),
      -x * Math.sin(yaw) + z * Math.cos(yaw),
    ]);
  const lying: Array<[number, number]> = [];
  for (let i = 0; i <= 30; i++) for (const w of [-4, 0, 4]) lying.push([-i, w]);

  it('turns a shell lying along -x to trail along -z', () => {
    const turned = rotate(lying, shellTrailYaw(lying, [0, 0]));
    const xs = turned.map((p) => p[0]);
    const zs = turned.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(8, 5);
    expect(Math.min(...zs)).toBeCloseTo(-30, 5);
    expect(Math.max(...zs)).toBeCloseTo(0, 5);
  });

  it('puts the far end behind the pivot whichever way the shell lies', () => {
    for (const lie of [0.3, 1.9, -2.4, 4.4]) {
      const pts = rotate(lying, lie);
      const turned = rotate(pts, shellTrailYaw(pts, [0, 0]));
      expect(Math.min(...turned.map((p) => p[1]))).toBeCloseTo(-30, 4);
      expect(Math.max(...turned.map((p) => p[1]))).toBeCloseTo(0, 4);
    }
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
      expect(recipe.maxTriangles).toBeLessThanOrEqual(25000);
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

  function slotEnds(crab: ShippedLegs): Map<number, { rootZ: number; reach: number }> {
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
    return new Map(
      [...sums].map(([slot, e]) => [
        slot,
        {
          rootZ: e.root[2]! / e.r,
          reach: Math.hypot(...[0, 1, 2].map((a) => e.root[a]! / e.r - e.tip[a]! / e.t)),
        },
      ]),
    );
  }

  it.each([0, 1, 2])(
    'LOD%i: slots 0 and 1 are the claws, rooted ahead of the walking legs on their side',
    async (level) => {
      const ends = slotEnds(await readCrab(level));
      for (const side of [0, 1]) {
        const claw = ends.get(side)!;
        for (const walker of [side + 2, side + 4])
          expect(claw.rootZ, `slot ${side} vs ${walker}`).toBeGreaterThan(
            ends.get(walker)!.rootZ + 0.05 * claw.reach,
          );
      }
      const reaches = [ends.get(0)!.reach, ends.get(1)!.reach];
      expect(Math.max(...reaches) / Math.min(...reaches)).toBeLessThanOrEqual(4);
    },
  );

  const standoffM = (): number => {
    const index = JSON.parse(readFileSync(join(assets, 'index.json'), 'utf8')) as {
      assets: Array<{ id: string; crab?: { standoffM: number } }>;
    };
    return index.assets.find((a) => a.id === 'hermit-crab')!.crab!.standoffM;
  };

  it.each([0, 1, 2])(
    'LOD%i: every walking leg tip reaches the substrate within 1 mm',
    async (level) => {
      const crab = await readCrab(level);
      const lowest = new Map<number, number>();
      for (let v = 0; v < crab.part.length; v++)
        if (isLeg(crab, v) && crab.leg[v]! >= 2)
          lowest.set(
            crab.leg[v]!,
            Math.min(lowest.get(crab.leg[v]!) ?? Infinity, crab.position[v * 3 + 1]!),
          );
      expect([...lowest.keys()].sort()).toEqual([2, 3, 4, 5]);
      for (const [slot, y] of lowest)
        expect(Math.abs(y + standoffM()), `slot ${slot}`).toBeLessThan(0.001);
    },
  );

  it.each([0, 1, 2])('LOD%i: the shell trails along the body axis', async (level) => {
    const crab = await readCrab(level);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < crab.part.length; v++)
      if (crab.part[v] === 0)
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a]!, crab.position[v * 3 + a]!);
          hi[a] = Math.max(hi[a]!, crab.position[v * 3 + a]!);
        }
    expect(hi[2]! - lo[2]!).toBeGreaterThan(1.5 * (hi[0]! - lo[0]!));
    expect(lo[2]!).toBeLessThan(-0.015);
  });

  it('keeps the triangle budgets and a shrinking LOD chain', async () => {
    const triangles = await Promise.all(
      [0, 1, 2].map(async (level) => (await readCrab(level)).indices.length / 3),
    );
    const [lod0, lod1, lod2] = triangles as [number, number, number];
    expect(lod0).toBeLessThanOrEqual(HERMIT_RECIPES[0]!.maxTriangles);
    expect(lod0).toBeGreaterThan(HERMIT_RECIPES[0]!.maxTriangles * 0.9);
    expect(lod1).toBeLessThan(lod0 * 0.5);
    expect(lod2).toBeLessThan(lod1 * 0.5);
    expect(lod2).toBeGreaterThan(1000);
  });

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
