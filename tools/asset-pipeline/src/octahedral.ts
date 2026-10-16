export type Vec3 = [number, number, number];

/**
 * Octahedral impostor layout. A view direction `d` (fish space, pointing from the fish towards the
 * camera) maps to atlas coordinates (u, v) in [0, 1]^2 through the unit-octahedron fold with +Y at
 * the centre of the square and -Y at its four corners. Frame (i, j) is rendered at the grid
 * *point* (i / (grid - 1), j / (grid - 1)), not at a cell centre, so neighbouring frames
 * interpolate exactly. With an odd grid, +Y, the four horizontal axes and -Y are frames of their
 * own; with an even grid none of them is.
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

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Unit normal `n` (fish space, facing the camera: dot(n, toward) >= 0) as the two stored channels
 * in [0, 1]. Expressed in the frame's own view basis, so it is continuous across the whole frame and
 * safe to filter and mip.
 */
export function encodeViewNormal(n: Vec3, basis: ViewBasis): [number, number] {
  return [0.5 + 0.5 * dot(n, basis.right), 0.5 + 0.5 * dot(n, basis.up)];
}

/** Inverse of `encodeViewNormal`: the fish-space normal from the two channels. */
export function decodeViewNormal(r: number, g: number, basis: ViewBasis): Vec3 {
  const x = r * 2 - 1;
  const y = g * 2 - 1;
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return [
    basis.right[0] * x + basis.up[0] * y + basis.toward[0] * z,
    basis.right[1] * x + basis.up[1] * y + basis.toward[1] * z,
    basis.right[2] * x + basis.up[2] * y + basis.toward[2] * z,
  ];
}

/**
 * Half a texel of the coarsest sampled mip level, as a fraction of one frame. Clamping a frame's UV
 * this far inside its edge keeps filtering and mips from reaching into the neighbouring frame.
 */
export function frameInset(frameSize: number, maxMipLevel: number): number {
  return (2 ** maxMipLevel * 0.5) / frameSize;
}

/**
 * Where to sample frame (i, j) for a point on the camera quad.
 *
 * `q` is that point relative to the pivot, in the quad built on `viewBasis(dCamera)` (so
 * `q = radius * (sx * right + sy * up)` for quad coordinates sx, sy in [-1, 1]); `dCamera` is the
 * unit direction from the pivot to the camera. The view ray runs along `-dCamera`. It is intersected
 * with the plane through the pivot perpendicular to the frame's own direction, because every frame
 * was rendered in its own basis (neighbouring frames are rotated against each other, by up to 180
 * degrees around the poles), so one shared UV would sample three different orientations. That
 * plane point is then expressed in the frame's basis, clamped `inset` inside the frame, and placed
 * in the atlas. Returns atlas UV with v = 0 at the first stored row.
 */
export function framePointUv(
  q: Vec3,
  dCamera: Vec3,
  i: number,
  j: number,
  grid: number,
  radius: number,
  inset: number,
): [number, number] {
  const dFrame = cellDirection(i, j, grid);
  const basis = viewBasis(dFrame);
  const along = Math.max(dot(dCamera, dFrame), 0.25);
  const t = dot(q, dFrame) / along;
  const x: Vec3 = [q[0] - t * dCamera[0], q[1] - t * dCamera[1], q[2] - t * dCamera[2]];
  const clamp = (v: number): number => Math.min(1 - inset, Math.max(inset, v));
  const lu = clamp(0.5 + (0.5 * dot(x, basis.right)) / radius);
  const lv = clamp(0.5 - (0.5 * dot(x, basis.up)) / radius);
  return [(i + lu) / grid, (j + lv) / grid];
}
