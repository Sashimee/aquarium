import {
  Color,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  MeshStandardNodeMaterial,
  Vector3,
  type BufferGeometry,
  type Material,
  type MeshStandardMaterial,
  type UniformNode,
} from 'three/webgpu';
import { diffuseColor, dot, mix, saturate, uniform, vec3 } from 'three/tsl';
import type { Biome, DecorItem } from '@aquarium/shared';
import type { CatalogEntry, LoadedModel } from './assets';
import { coralGlow, coralTint, placementKey, heightScale } from './coralStyle';
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
    new Vector3(item.scale, item.scale * heightScale(item.assetId), item.scale),
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

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** Tissue glows more where the albedo is bright, so the emission follows the polyps rather than the skeleton. */
function fluorescentMaterial(
  source: MeshStandardMaterial,
  glow: Color,
  level: UniformNode<'float', number>,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = source.name;
  material.color.copy(source.color);
  material.map = source.map;
  material.normalMap = source.normalMap;
  material.normalScale.copy(source.normalScale);
  material.roughnessMap = source.roughnessMap;
  material.aoMap = source.aoMap;
  material.roughness = source.roughness;
  material.metalness = source.metalness;
  material.side = source.side;
  const tissue = mix(0.4, 1.4, saturate(dot(diffuseColor.rgb, LUMA).mul(2)));
  material.emissiveNode = uniform(glow).mul(level).mul(tissue);
  return material;
}

export class Hardscape {
  readonly group = new Group();
  private readonly meshesByItem: Mesh[][] = [];
  private readonly tintedMaterials: Material[] = [];

  constructor(
    private readonly biome: Biome,
    private readonly fluorescence: UniformNode<'float', number>,
  ) {
    this.group.name = 'hardscape';
  }

  add(entry: CatalogEntry, model: LoadedModel, item: DecorItem): void {
    const matrix = decorMatrix(item);
    const meshes: Mesh[] = [];
    this.meshesByItem.push(meshes);
    const key = placementKey(item.position, item.rotationY);
    const tint = coralTint(item.assetId, key);
    for (const primitive of model.primitives) {
      let material: Material = primitive.material;
      if (tint) {
        const tinted = primitive.material.clone();
        tinted.color.multiply(tint);
        const glow = coralGlow(this.biome, item.assetId, key);
        material = glow ? fluorescentMaterial(tinted, glow, this.fluorescence) : tinted;
        if (material !== tinted) tinted.dispose();
        this.tintedMaterials.push(material);
      }
      const mesh = new Mesh(primitive.geometry, material);
      meshes.push(mesh);
      mesh.name = `${entry.id}:${material.name}`;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  setItem(index: number, item: DecorItem): void {
    const matrix = decorMatrix(item);
    for (const mesh of this.meshesByItem[index] ?? []) mesh.matrix.copy(matrix);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.clear();
    for (const material of this.tintedMaterials) material.dispose();
  }
}
