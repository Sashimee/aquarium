import type { Quaternion, Vector3 } from 'three/webgpu';

/**
 * The CPU half of the octahedral impostor lookup, ported unchanged from the bake's reference
 * (`tools/asset-pipeline/src/octahedral.ts`, contract in `tools/asset-pipeline/IMPOSTOR.md`). The
 * shader half, which samples each frame at its own UV, is in `impostorMaterial.ts`.
 */
export type Vec3 = readonly [number, number, number];

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

/**
 * The four frames to blend for view direction `d`: (i, j), (i + 1, j), (i, j + 1) and (i + 1, j + 1),
 * weighted bilinearly by `fx` along i and `fy` along j. Frames sit on grid points, so a view along
 * a frame's own direction gets that frame alone.
 */
export interface FrameSelection {
  i: number;
  j: number;
  fx: number;
  fy: number;
}

export function selectFrames(d: Vec3, grid: number, out: FrameSelection): FrameSelection {
  if (!(Number.isInteger(grid) && grid >= 2)) {
    throw new RangeError(`impostor: grid must be an integer >= 2, got ${grid}`);
  }
  const [u, v] = directionToUv(d);
  const gx = Math.min(grid - 1 - 1e-9, Math.max(0, u * (grid - 1)));
  const gy = Math.min(grid - 1 - 1e-9, Math.max(0, v * (grid - 1)));
  out.i = Math.floor(gx);
  out.j = Math.floor(gy);
  out.fx = gx - out.i;
  out.fy = gy - out.j;
  return out;
}

/** Half a texel of the coarsest sampled mip level, as a fraction of one frame. */
export function frameInset(frameSize: number, maxMipLevel: number): number {
  return (2 ** maxMipLevel * 0.5) / frameSize;
}

/** Mips are built across the whole atlas; below a 16 px frame they blur neighbouring frames in. */
export function maxFrameMip(frameSize: number): number {
  return Math.max(0, Math.log2(frameSize) - 4);
}

/**
 * Unit direction from the impostor pivot towards the camera, in fish space, for a fish drawn at
 * `position` with `quaternion` and uniform `scale`; `pivot` is in fish space. Writes `out`.
 */
export function fishViewDirection(
  camera: Vector3,
  position: Vector3,
  quaternion: Quaternion,
  scale: number,
  pivot: Vec3,
  out: Vector3,
): Vector3 {
  out.copy(camera).sub(position);
  const { x, y, z, w } = quaternion;
  // Rotate by the conjugate: world offset into fish axes.
  const tx = 2 * (-y * out.z + z * out.y);
  const ty = 2 * (-z * out.x + x * out.z);
  const tz = 2 * (-x * out.y + y * out.x);
  const fx = out.x + w * tx + (-y * tz + z * ty);
  const fy = out.y + w * ty + (-z * tx + x * tz);
  const fz = out.z + w * tz + (-x * ty + y * tx);
  out.set(fx - scale * pivot[0], fy - scale * pivot[1], fz - scale * pivot[2]);
  const length = out.length();
  // A camera inside the pivot has no view direction; any side-on frame will do.
  return length > 1e-9 ? out.divideScalar(length) : out.set(1, 0, 0);
}
