export type Vec3 = [number, number, number];

/**
 * Octahedral impostor layout. A view direction `d` (fish space, pointing from the fish towards the
 * camera) maps to atlas coordinates (u, v) in [0, 1]^2 through the unit-octahedron fold with +Y at
 * the centre of the square and -Y at its four corners. Frame (i, j) is rendered at the grid
 * *point* (i / (grid - 1), j / (grid - 1)), not at a cell centre, so neighbouring frames
 * interpolate exactly and the poles and the equator are frames of their own.
 */

export function directionToUv(d: Vec3): [number, number] {
  const sum = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]);
  let x = d[0] / sum;
  let z = d[2] / sum;
  if (d[1] < 0) {
    const fx = (1 - Math.abs(z)) * (x >= 0 ? 1 : -1);
    const fz = (1 - Math.abs(x)) * (z >= 0 ? 1 : -1);
    x = fx;
    z = fz;
  }
  return [x * 0.5 + 0.5, z * 0.5 + 0.5];
}

export function uvToDirection(u: number, v: number): Vec3 {
  let x = u * 2 - 1;
  let z = v * 2 - 1;
  const y = 1 - Math.abs(x) - Math.abs(z);
  if (y < 0) {
    const fx = (1 - Math.abs(z)) * (x >= 0 ? 1 : -1);
    const fz = (1 - Math.abs(x)) * (z >= 0 ? 1 : -1);
    x = fx;
    z = fz;
  }
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

export function cellUv(i: number, j: number, grid: number): [number, number] {
  return [i / (grid - 1), j / (grid - 1)];
}

export function cellDirection(i: number, j: number, grid: number): Vec3 {
  const [u, v] = cellUv(i, j, grid);
  return uvToDirection(u, v);
}

export interface CellWeight {
  i: number;
  j: number;
  weight: number;
}

/** The four frames around `d` with bilinear weights summing to 1; the reference for the shader blend. */
export function blendCells(d: Vec3, grid: number): CellWeight[] {
  const [u, v] = directionToUv(d);
  const gx = Math.min(grid - 1 - 1e-9, Math.max(0, u * (grid - 1)));
  const gy = Math.min(grid - 1 - 1e-9, Math.max(0, v * (grid - 1)));
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  const fx = gx - i;
  const fy = gy - j;
  return [
    { i, j, weight: (1 - fx) * (1 - fy) },
    { i: i + 1, j, weight: fx * (1 - fy) },
    { i, j: j + 1, weight: (1 - fx) * fy },
    { i: i + 1, j: j + 1, weight: fx * fy },
  ];
}

export interface ViewBasis {
  right: Vec3;
  up: Vec3;
  toward: Vec3;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const normalise = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** Orthonormal camera frame of a frame's view: screen right, screen up and `toward` (= d, the direction to the camera). */
export function viewBasis(d: Vec3): ViewBasis {
  const reference: Vec3 = Math.abs(d[1]) > 1 - 1e-6 ? [0, 0, 1] : [0, 1, 0];
  const right = normalise(cross(reference, d));
  return { right, up: cross(d, right), toward: d };
}
