import type { Vec3 } from '../camera';

export interface CameraMatrices {
  readonly matrixWorld: { readonly elements: ArrayLike<number> };
  readonly projectionMatrixInverse: { readonly elements: ArrayLike<number> };
}

export interface PickRay {
  readonly origin: Vec3;
  readonly dir: Vec3;
}

function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number): Vec3 {
  const e = (i: number): number => m[i] ?? 0;
  const w = 1 / (e(3) * x + e(7) * y + e(11) * z + e(15));
  return {
    x: (e(0) * x + e(4) * y + e(8) * z + e(12)) * w,
    y: (e(1) * x + e(5) * y + e(9) * z + e(13)) * w,
    z: (e(2) * x + e(6) * y + e(10) * z + e(14)) * w,
  };
}

/** The ray three's Raycaster casts for a perspective camera, without pulling three.js into the decor chunk. */
export function perspectiveRay(camera: CameraMatrices, ndcX: number, ndcY: number): PickRay {
  const world = camera.matrixWorld.elements;
  const origin = { x: world[12] ?? 0, y: world[13] ?? 0, z: world[14] ?? 0 };
  const view = transformPoint(camera.projectionMatrixInverse.elements, ndcX, ndcY, 0.5);
  const target = transformPoint(world, view.x, view.y, view.z);
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  return { origin, dir: { x: dx / length, y: dy / length, z: dz / length } };
}
