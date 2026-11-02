import {
  Color,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
  BufferAttribute,
  type BufferGeometry,
  type MeshStandardMaterial,
  type Node,
  type UniformNode,
} from 'three/webgpu';
import {
  attribute,
  diffuseColor,
  dot,
  materialEmissive,
  mix,
  modelScale,
  normalWorld,
  positionLocal,
  saturate,
  vec3,
} from 'three/tsl';
import { legacyTintSeed, type Biome, type DecorItem } from '@aquarium/shared';
import type { CatalogEntry, LoadedModel } from './assets';
import { clamp01, coralGlow, coralTint, heightScale } from './coralStyle';
import { coralBleachColor, setMaterialBleach } from '../engine/coralBleach';
import { polypGain } from './polyps';
import { hasShelterParts, placedShelterParts } from './shelterParts';
import { fitCapsuleChain, fitHull, transformPoints, type Collider } from './colliders';

export const HARDSCAPE_KINDS: ReadonlySet<string> = new Set([
  'rock',
  'driftwood',
  'decor',
  'coral',
]);

export const PLANT_KIND = 'plant';

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

/**
 * Driftwood is long and thin, so a capsule chain hugs it; stone and shells use a convex hull. A
 * shelter gets one hull per convex part, the same parts the decor layer reports to the sim.
 */
export function fitCollider(
  kind: string,
  geometries: readonly BufferGeometry[],
  item: DecorItem,
): Collider[] {
  if (hasShelterParts(item.assetId)) {
    return placedShelterParts(item).map((corners) => fitHull(corners.flat()));
  }
  const points = mergedPositions(geometries, decorMatrix(item));
  return kind === 'driftwood' ? fitCapsuleChain(points, WOOD_SEGMENTS) : [fitHull(points)];
}

const LUMA = vec3(0.2126, 0.7152, 0.0722);
const UNDERSIDE_GLOW = 0.3;
const POLYP_SWELL_METRES = 0.0015;

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

export const SWELL_NORMAL_ATTRIBUTE = '_swellNormal';
const WELD_EPSILON = 1e-4;

/**
 * Per-vertex normals averaged over every vertex sharing a position, so the swell moves a seam's
 * two sides together instead of opening it. Where the shared normals cancel the vertex stays put.
 */
export function weldedNormals(geometry: BufferGeometry): Float32Array {
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const count = positions.count;
  const keyOf = (i: number) => `${positions.getX(i)},${positions.getY(i)},${positions.getZ(i)}`;
  const sums = new Map<string, [number, number, number]>();
  for (let i = 0; i < count; i++) {
    const key = keyOf(i);
    let sum = sums.get(key);
    if (!sum) {
      sum = [0, 0, 0];
      sums.set(key, sum);
    }
    sum[0] += normals.getX(i);
    sum[1] += normals.getY(i);
    sum[2] += normals.getZ(i);
  }
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = sums.get(keyOf(i)) ?? [0, 0, 0];
    const length = Math.hypot(x, y, z);
    if (length < WELD_EPSILON) continue;
    out[i * 3] = x / length;
    out[i * 3 + 1] = y / length;
    out[i * 3 + 2] = z / length;
  }
  return out;
}

/**
 * Displacement along the welded normal worth `POLYP_SWELL_METRES * gain` in the world: dividing by
 * the world scale per axis undoes a non-uniform squash, so the top of a flattened coral swells as
 * much as its sides.
 */
export function swelledPosition(
  extension: Node<'float'>,
  gain: number,
  position: Node<'vec3'> = positionLocal,
  normal: Node<'vec3'> = attribute(SWELL_NORMAL_ATTRIBUTE, 'vec3'),
  scale: Node<'vec3'> = modelScale,
): Node<'vec3'> {
  return position.add(normal.mul(extension.mul(POLYP_SWELL_METRES * gain)).div(scale));
}

// Every coral carries a colour node, so none shares a shader program with rocks: sharing would need a
// material swap on the first bleach, which misses the Engine.ts prewarm and stalls a WebGL2 compile mid-session.
function coralMaterial(source: MeshStandardMaterial, tint: Color | null): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  // NodeMaterial.copy skips the private-backed accessors (alphaTest), which Material.copy handles.
  Material.prototype.copy.call(material, source);
  material.copy(source);
  if (tint) material.color.multiply(tint);
  setMaterialBleach(material, 0);
  material.colorNode = coralBleachColor;
  return material;
}

function fluorescentMaterial(
  source: MeshStandardMaterial,
  tint: Color,
  glow: Color,
  glowNode: Node<'vec3'>,
  swell: Node<'vec3'> | null,
): MeshStandardNodeMaterial {
  const material = coralMaterial(source, tint);
  material.emissive.copy(glow);
  material.emissiveIntensity = 1;
  material.emissiveNode = glowNode;
  if (swell) material.positionNode = swell;
  return material;
}

function isStandard(material: Material): material is MeshStandardMaterial {
  return 'emissive' in material && 'color' in material;
}

interface BleachableMaterial {
  readonly material: MeshStandardMaterial;
  readonly emissive: Color;
}

/** The shared draws of every untinted, non-coral item of one asset: one `InstancedMesh` per primitive. */
class InstanceBatch {
  private meshes: InstancedMesh[] = [];
  private count = 0;

  constructor(
    private readonly group: Group,
    private readonly name: (primitive: number) => string,
    private readonly primitives: LoadedModel['primitives'],
  ) {}

  add(matrix: Matrix4): number {
    const slot = this.count++;
    if (this.meshes.length === 0 || slot >= (this.meshes[0]?.instanceMatrix.count ?? 0))
      this.grow();
    this.setMatrix(slot, matrix);
    for (const mesh of this.meshes) mesh.count = this.count;
    return slot;
  }

  setMatrix(slot: number, matrix: Matrix4): void {
    for (const mesh of this.meshes) {
      mesh.setMatrixAt(slot, matrix);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
    }
  }

  private grow(): void {
    const capacity = Math.max(4, this.count * 2);
    this.meshes = this.primitives.map((primitive, i) => {
      const previous = this.meshes[i];
      const mesh = new InstancedMesh(primitive.geometry, primitive.material, capacity);
      mesh.name = this.name(i);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (previous) {
        mesh.instanceMatrix.array.set(previous.instanceMatrix.array);
        previous.removeFromParent();
        previous.dispose();
      }
      this.group.add(mesh);
      return mesh;
    });
  }
}

export class Hardscape {
  readonly group = new Group();
  private readonly meshesByItem: Mesh[][] = [];
  private readonly batches = new Map<string, InstanceBatch>();
  private readonly instanced = new Map<number, { batch: InstanceBatch; slot: number }>();
  private itemCount = 0;
  private readonly tintedMaterials: Material[] = [];
  private readonly bleachables: BleachableMaterial[][] = [];
  private readonly swellNodes = new Map<number, Node<'vec3'>>();

  constructor(
    private readonly biome: Biome,
    private readonly glowNode: Node<'vec3'>,
    private readonly polyps: Node<'float'>,
  ) {
    this.group.name = 'hardscape';
  }

  add(entry: CatalogEntry, model: LoadedModel, item: DecorItem): void {
    const matrix = decorMatrix(item);
    const index = this.itemCount++;
    const key = item.tintSeed ?? legacyTintSeed(item);
    const tint = coralTint(item.assetId, key);
    if (entry.kind !== 'coral' && !tint) {
      let batch = this.batches.get(item.assetId);
      if (!batch) {
        batch = new InstanceBatch(
          this.group,
          (i) => `${entry.id}:${model.primitives[i]?.material.name ?? i}`,
          model.primitives,
        );
        this.batches.set(item.assetId, batch);
      }
      this.instanced.set(index, { batch, slot: batch.add(matrix) });
      this.meshesByItem.push([]);
      this.bleachables.push([]);
      return;
    }
    const meshes: Mesh[] = [];
    this.meshesByItem.push(meshes);
    const bleachables: BleachableMaterial[] = [];
    this.bleachables.push(bleachables);
    for (const primitive of model.primitives) {
      let material: Material = primitive.material;
      if (tint) {
        const glow = coralGlow(this.biome, item.assetId, key);
        if (glow) {
          material = fluorescentMaterial(
            primitive.material,
            tint,
            glow,
            this.glowNode,
            this.swellNode(item, primitive.geometry),
          );
        } else if (entry.kind === 'coral') {
          material = coralMaterial(primitive.material, tint);
        } else {
          material = primitive.material.clone();
          (material as MeshStandardMaterial).color.multiply(tint);
        }
        this.tintedMaterials.push(material);
      } else if (entry.kind === 'coral') {
        material = coralMaterial(primitive.material, null);
        this.tintedMaterials.push(material);
      }
      if (entry.kind === 'coral' && isStandard(material)) {
        bleachables.push({ material, emissive: material.emissive.clone() });
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

  /** Tissue swells along the welded normal as the polyps come out; null for a coral without nocturnal polyps. */
  private swellNode(item: DecorItem, geometry: BufferGeometry): Node<'vec3'> | null {
    const gain = polypGain(item.assetId);
    if (gain === 0) return null;
    if (!geometry.hasAttribute(SWELL_NORMAL_ATTRIBUTE)) {
      geometry.setAttribute(
        SWELL_NORMAL_ATTRIBUTE,
        new BufferAttribute(weldedNormals(geometry), 3),
      );
    }
    let node = this.swellNodes.get(gain);
    if (!node) {
      node = swelledPosition(this.polyps, gain);
      this.swellNodes.set(gain, node);
    }
    return node;
  }

  setItem(index: number, item: DecorItem): void {
    const matrix = decorMatrix(item);
    const shared = this.instanced.get(index);
    if (shared) shared.batch.setMatrix(shared.slot, matrix);
    for (const mesh of this.meshesByItem[index] ?? []) mesh.matrix.copy(matrix);
  }

  setBleach(index: number, bleach: number): void {
    for (const { material, emissive } of this.bleachables[index] ?? []) {
      setMaterialBleach(material, bleach);
      material.emissive.copy(emissive).multiplyScalar(1 - clamp01(bleach));
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const child of this.group.children) (child as Partial<InstancedMesh>).dispose?.();
    this.group.clear();
    for (const material of this.tintedMaterials) material.dispose();
  }
}
