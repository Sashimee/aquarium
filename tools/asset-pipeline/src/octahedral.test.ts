import { describe, expect, it } from 'vitest';
import {
  blendCells,
  cellDirection,
  decodeViewNormal,
  directionToUv,
  encodeViewNormal,
  frameInset,
  framePointUv,
  uvToDirection,
  viewBasis,
  type Vec3,
} from './octahedral.ts';

function directions(count: number): Vec3[] {
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, () => {
    const z = next() * 2 - 1;
    const angle = next() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(angle), z, r * Math.sin(angle)] as Vec3;
  });
}

const near = (a: Vec3, b: Vec3, digits = 9): void =>
  a.forEach((value, k) => expect(value).toBeCloseTo(b[k]!, digits));

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('octahedral mapping', () => {
  it('round-trips directions on both hemispheres', () => {
    for (const d of directions(500)) {
      const [u, v] = directionToUv(d);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      near(uvToDirection(u, v), d);
    }
  });

  it('puts +Y at the centre, the axes on the edge midpoints and -Y in all four corners', () => {
    near(uvToDirection(0.5, 0.5), [0, 1, 0]);
    near(uvToDirection(1, 0.5), [1, 0, 0]);
    near(uvToDirection(0, 0.5), [-1, 0, 0]);
    near(uvToDirection(0.5, 1), [0, 0, 1]);
    near(uvToDirection(0.5, 0), [0, 0, -1]);
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const)
      near(uvToDirection(u, v), [0, -1, 0]);
  });

  it('gives every frame of the grid a unit direction', () => {
    for (const grid of [2, 5, 8])
      for (let j = 0; j < grid; j++)
        for (let i = 0; i < grid; i++)
          expect(Math.hypot(...cellDirection(i, j, grid))).toBeCloseTo(1, 12);
  });

  it('puts the frames at grid points so odd grids contain the axis views', () => {
    for (const grid of [5, 9]) {
      const mid = (grid - 1) / 2;
      const end = grid - 1;
      near(cellDirection(end, mid, grid), [1, 0, 0]);
      near(cellDirection(0, mid, grid), [-1, 0, 0]);
      near(cellDirection(mid, end, grid), [0, 0, 1]);
      near(cellDirection(mid, 0, grid), [0, 0, -1]);
      near(cellDirection(mid, mid, grid), [0, 1, 0]);
      near(cellDirection(0, 0, grid), [0, -1, 0]);
    }
  });
});

describe('blendCells', () => {
  it('returns four in-range frames whose weights sum to 1', () => {
    for (const grid of [2, 8])
      for (const d of directions(300)) {
        const cells = blendCells(d, grid);
        expect(cells.reduce((sum, c) => sum + c.weight, 0)).toBeCloseTo(1, 12);
        for (const c of cells) {
          expect(c.i).toBeGreaterThanOrEqual(0);
          expect(c.i).toBeLessThanOrEqual(grid - 1);
          expect(c.j).toBeGreaterThanOrEqual(0);
          expect(c.j).toBeLessThanOrEqual(grid - 1);
          expect(c.weight).toBeGreaterThanOrEqual(0);
        }
      }
  });

  it('puts the whole weight on a frame with the same direction when looking exactly along it', () => {
    const grid = 8;
    for (const [i, j] of [
      [0, 0],
      [3, 5],
      [7, 7],
      [7, 2],
    ] as const) {
      const d = cellDirection(i, j, grid);
      const heavy = blendCells(d, grid).find((c) => c.weight > 0.999);
      expect(heavy).toBeDefined();
      near(cellDirection(heavy!.i, heavy!.j, grid), d);
    }
  });

  it('blends the two frames either side of a midpoint equally', () => {
    const weights = blendCells(uvToDirection(3.5 / 7, 4 / 7), 8).filter((c) => c.weight > 1e-9);
    expect(weights).toHaveLength(2);
    for (const c of weights) expect(c.weight).toBeCloseTo(0.5, 9);
  });
});

describe('viewBasis', () => {
  it('is orthonormal and right-handed for every frame', () => {
    for (let j = 0; j < 8; j++)
      for (let i = 0; i < 8; i++) {
        const { right, up, toward } = viewBasis(cellDirection(i, j, 8));
        expect(Math.hypot(...right)).toBeCloseTo(1, 12);
        expect(Math.hypot(...up)).toBeCloseTo(1, 12);
        expect(dot(right, up)).toBeCloseTo(0, 12);
        expect(dot(right, toward)).toBeCloseTo(0, 12);
        near(
          [
            right[1] * up[2] - right[2] * up[1],
            right[2] * up[0] - right[0] * up[2],
            right[0] * up[1] - right[1] * up[0],
          ],
          toward,
          12,
        );
      }
  });

  it('looks at a fish from its +Z side with +X to the right and +Y up', () => {
    const { right, up } = viewBasis([0, 0, 1]);
    near(right, [1, 0, 0]);
    near(up, [0, 1, 0]);
  });

  it('stays defined on the poles', () => {
    for (const d of [
      [0, 1, 0],
      [0, -1, 0],
    ] as Vec3[]) {
      const { right, up } = viewBasis(d);
      expect(Math.hypot(...right)).toBeCloseTo(1, 12);
      expect(Math.hypot(...up)).toBeCloseTo(1, 12);
    }
  });
});

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
};

describe('view-space normals', () => {
  it('round-trips camera-facing normals through every frame basis', () => {
    const grid = 9;
    const normals = directions(200);
    for (let j = 0; j < grid; j++)
      for (let i = 0; i < grid; i++) {
        const basis = viewBasis(cellDirection(i, j, grid));
        for (const raw of normals) {
          const n: Vec3 = dot(raw, basis.toward) < 0 ? [-raw[0], -raw[1], -raw[2]] : raw;
          const [r, g] = encodeViewNormal(n, basis);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(1);
          near(decodeViewNormal(r, g, basis), n, 9);
        }
      }
  });

  it('keeps a smooth surface smooth: neighbouring normals encode to neighbouring values', () => {
    const basis = viewBasis(cellDirection(1, 1, 9));
    const around = (angle: number): Vec3 => {
      const n = unit([
        basis.toward[0] * 0.3 + basis.right[0] * Math.cos(angle) + basis.up[0] * Math.sin(angle),
        basis.toward[1] * 0.3 + basis.right[1] * Math.cos(angle) + basis.up[1] * Math.sin(angle),
        basis.toward[2] * 0.3 + basis.right[2] * Math.cos(angle) + basis.up[2] * Math.sin(angle),
      ]);
      return n;
    };
    let previous = encodeViewNormal(around(0), basis);
    for (let step = 1; step <= 360; step++) {
      const next = encodeViewNormal(around((step * Math.PI) / 180), basis);
      expect(Math.abs(next[0] - previous[0])).toBeLessThan(0.02);
      expect(Math.abs(next[1] - previous[1])).toBeLessThan(0.02);
      previous = next;
    }
  });
});

describe('framePointUv', () => {
  const grid = 9;
  const radius = 0.5;
  const dCamera = cellDirection(5, 6, grid);
  const camera = viewBasis(dCamera);
  const at = (sx: number, sy: number): Vec3 => [
    radius * (sx * camera.right[0] + sy * camera.up[0]),
    radius * (sx * camera.right[1] + sy * camera.up[1]),
    radius * (sx * camera.right[2] + sy * camera.up[2]),
  ];

  it('is the plain quad coordinate inside the frame when the camera looks along it', () => {
    const [u, v] = framePointUv(at(0.5, -0.25), dCamera, 5, 6, grid, radius, 0);
    expect(u).toBeCloseTo((5 + 0.75) / grid, 12);
    expect(v).toBeCloseTo((6 + 0.625) / grid, 12);
  });

  it('lands each neighbour on the texel that shows a point on both frame planes', () => {
    const frames: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [4, 4],
      [5, 4],
      [4, 8],
      [8, 4],
    ];
    for (const [i, j] of frames) {
      const neighbours: [number, number][] = [
        [i + 1 < grid ? i + 1 : i - 1, j],
        [i, j + 1 < grid ? j + 1 : j - 1],
      ];
      for (const [ni, nj] of neighbours) {
        const a = cellDirection(i, j, grid);
        const b = cellDirection(ni, nj, grid);
        const shared = cross(a, b);
        if (Math.hypot(...shared) < 1e-9) continue;
        const point = unit(shared).map((c) => c * radius * 0.6) as Vec3;
        const between = unit([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
        const quad = viewBasis(between);
        const hit: Vec3 = [0, 1, 2].map(
          (k) => point[k]! - dot(point, between) * between[k]!,
        ) as Vec3;
        expect(dot(hit, quad.toward)).toBeCloseTo(0, 12);
        for (const [fi, fj] of [
          [i, j],
          [ni, nj],
        ] as const) {
          const frame = viewBasis(cellDirection(fi, fj, grid));
          const expectedU = (fi + 0.5 + (0.5 * dot(point, frame.right)) / radius) / grid;
          const expectedV = (fj + 0.5 - (0.5 * dot(point, frame.up)) / radius) / grid;
          const [u, v] = framePointUv(hit, between, fi, fj, grid, radius, 0);
          expect(u).toBeCloseTo(expectedU, 9);
          expect(v).toBeCloseTo(expectedV, 9);
        }
      }
    }
  });

  it('does not sample the three rotated copies of the fish that share one UV near -Y', () => {
    const below = unit([0.05, -1, 0.03]);
    const quad = viewBasis(below);
    const hit: Vec3 = [
      0.4 * radius * quad.right[0] + 0.2 * radius * quad.up[0],
      0.4 * radius * quad.right[1] + 0.2 * radius * quad.up[1],
      0.4 * radius * quad.right[2] + 0.2 * radius * quad.up[2],
    ];
    const local = ([u, v]: [number, number], i: number, j: number): [number, number] => [
      u * grid - i,
      v * grid - j,
    ];
    const first = local(framePointUv(hit, below, 0, 0, grid, radius, 0), 0, 0);
    const second = local(framePointUv(hit, below, 1, 0, grid, radius, 0), 1, 0);
    expect(Math.hypot(first[0] - second[0], first[1] - second[1])).toBeGreaterThan(0.1);
  });

  it('clamps the sample inside the frame edge', () => {
    const inset = frameInset(128, 3);
    expect(inset).toBeCloseTo(1 / 32, 12);
    const [u, v] = framePointUv(at(1, -1), dCamera, 5, 6, grid, radius, inset);
    expect(u).toBeCloseTo((5 + 1 - inset) / grid, 12);
    expect(v).toBeCloseTo((6 + 1 - inset) / grid, 12);
    const [lowU, lowV] = framePointUv(at(-1, 1), dCamera, 5, 6, grid, radius, inset);
    expect(lowU).toBeCloseTo((5 + inset) / grid, 12);
    expect(lowV).toBeCloseTo((6 + inset) / grid, 12);
  });
});
