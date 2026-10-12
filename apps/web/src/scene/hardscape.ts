import { Group, Matrix4, Mesh, Quaternion, Vector3, type BufferGeometry } from 'three/webgpu';
import type { DecorItem } from '@aquarium/shared';
import type { CatalogEntry, LoadedModel } from './assets';
import { fitCapsuleChain, fitHull, transformPoints, type Collider } from './colliders';

export const HARDSCAPE_KINDS: ReadonlySet<string> = new Set([
  'rock',
  'driftwood',
  'decor',
  'coral',
]);

const WOOD_SEGMENTS = 5;
const UP = new Vector3(0, 1, 0);

export function decorMatrix(item: DecorItem): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...item.position),
    new Quaternion().setFromAxisAngle(UP, item.rotationY),
    new Vector3(item.scale, item.scale, item.scale),
  );
}

function mergedPositions(geometries: readonly BufferGeometry[], matrix: Matrix4): Float64Array {
  const parts = geometries.map((geometry) => {
    const attribute = geometry.getAttribute('position');
    return transformPoints(attribute.array, matrix.elements);
  });
  const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Driftwood is long and thin, so a capsule chain hugs it; stone and shells use a convex hull. */
export function fitCollider(
  kind: string,
  geometries: readonly BufferGeometry[],
  item: DecorItem,
): Collider[] {
  const points = mergedPositions(geometries, decorMatrix(item));
  return kind === 'driftwood' ? fitCapsuleChain(points, WOOD_SEGMENTS) : [fitHull(points)];
}

export class Hardscape {
  readonly group = new Group();

  constructor() {
    this.group.name = 'hardscape';
  }

  add(entry: CatalogEntry, model: LoadedModel, item: DecorItem): void {
    const matrix = decorMatrix(item);
    for (const { geometry, material } of model.primitives) {
      const mesh = new Mesh(geometry, material);
      mesh.name = `${entry.id}:${material.name}`;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.clear();
  }
}
