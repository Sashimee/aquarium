import {
  Color,
  Group,
  Material,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type MeshStandardMaterial,
  type Node,
  type UniformNode,
} from 'three/webgpu';
import { diffuseColor, dot, materialEmissive, mix, normalWorld, saturate, vec3 } from 'three/tsl';
import type { Biome, DecorItem } from '@aquarium/shared';
import type { CatalogEntry, LoadedModel } from './assets';
import { coralGlow, coralTint, heightScale, placementKey } from './coralStyle';
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
const UNDERSIDE_GLOW = 0.3;

/**
 * Emission graph shared by every fluorescent coral, so the shader builder sees one cache key. The
 * glow colour arrives through `material.emissive`. Tissue glows more where the albedo is bright, so
 * the emission follows the polyps rather than the skeleton, and the excitation comes from above, so
 * downward faces get a fraction of it.
 */
export function createCoralGlowNode(level: UniformNode<'float', number>): Node<'vec3'> {
  const tissue = mix(0.4, 1.4, saturate(dot(diffuseColor.rgb, LUMA).mul(2)));
  const facing = mix(UNDERSIDE_GLOW, 1, normalWorld.y.mul(0.5).add(0.5));
  return materialEmissive.mul(level).mul(tissue).mul(facing);
}

function fluorescentMaterial(
  source: MeshStandardMaterial,
  tint: Color,
  glow: Color,
  glowNode: Node<'vec3'>,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  // NodeMaterial.copy skips the private-backed accessors (alphaTest), which Material.copy handles.
  Material.prototype.copy.call(material, source);
  material.copy(source);
  material.color.multiply(tint);
  material.emissive.copy(glow);
  material.emissiveIntensity = 1;
  material.emissiveNode = glowNode;
  return material;
}

export class Hardscape {
  readonly group = new Group();
  private readonly meshesByItem: Mesh[][] = [];
  private readonly tintedMaterials: Material[] = [];

  constructor(
    private readonly biome: Biome,
    private readonly glowNode: Node<'vec3'>,
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
        const glow = coralGlow(this.biome, item.assetId, key);
        if (glow) {
          material = fluorescentMaterial(primitive.material, tint, glow, this.glowNode);
        } else {
          material = primitive.material.clone();
          (material as MeshStandardMaterial).color.multiply(tint);
        }
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
