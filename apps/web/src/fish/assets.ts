import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Texture,
  type InterleavedBufferAttribute,
  type Material,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { gltfKtx2Loader, rewritingKtx2Loader, type Ktx2Textures } from '../engine/ktx2';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { parseFishAssets, type FishAssetEntry } from './assetIndex';

/** One draw per material: the merged primitives of a LOD that share it. */
export interface FishPart {
  readonly geometry: BufferGeometry;
  readonly source: MeshStandardMaterial;
  /** A walker's hip for each `_leg` index, null where this LOD has no such leg; empty for a fish. */
  readonly legPivots: readonly (Vec3 | null)[];
}

export type Vec3 = readonly [number, number, number];

export type FishTextureSize = 1024 | 2048;

export interface FishModel {
  readonly entry: FishAssetEntry;
  readonly textureSize: FishTextureSize;
  /** `lods[level]` holds that level's parts; every level reuses lod0's materials where it can. */
  readonly lods: readonly (readonly FishPart[])[];
}

/**
 * `_fin_mask` and `_fin_id` share one vec2, and a walker's `_leg` makes it a vec3, so the models
 * stay within WebGPU's 8 vertex buffers.
 */
export const FIN_ATTRIBUTE = 'fin';
/** `_fin_id` of a shrimp's walking legs and chelipeds. */
export const LEG_PART_ID = 6;
/** Hip vertices sit at the minimum limb weight; the simplified LODs may shift it slightly. */
const HIP_WEIGHT_SLACK = 0.02;
const KEPT_ATTRIBUTES = ['position', 'normal', 'uv'] as const;

function toFloat32(attribute: BufferAttribute | InterleavedBufferAttribute): BufferAttribute {
  const { count, itemSize } = attribute;
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < itemSize; c++) out[i * itemSize + c] = attribute.getComponent(i, c);
  }
  return new BufferAttribute(out, itemSize);
}

/**
 * Bakes the node transform and repacks the fin attributes, with `_leg` when `limbs`; the result is
 * unquantised float32.
 */
export function prepareFishGeometry(mesh: Mesh, label: string, limbs = false): BufferGeometry {
  const source = mesh.geometry;
  const mask = source.getAttribute('_fin_mask');
  const id = source.getAttribute('_fin_id');
  if (mask === undefined || id === undefined) {
    throw new Error(`${label}: _FIN_MASK/_FIN_ID attributes missing; re-run the asset pipeline`);
  }
  const leg = limbs ? source.getAttribute('_leg') : undefined;
  if (limbs && leg === undefined) {
    throw new Error(`${label}: shrimp _LEG attribute missing; re-run the asset pipeline`);
  }
  const geometry = new BufferGeometry();
  for (const name of KEPT_ATTRIBUTES) {
    const attribute = source.getAttribute(name);
    if (attribute === undefined) throw new Error(`${label}: vertex attribute "${name}" missing`);
    geometry.setAttribute(name, toFloat32(attribute));
  }
  const size = leg === undefined ? 2 : 3;
  const fin = new Float32Array(mask.count * size);
  for (let i = 0; i < mask.count; i++) {
    fin[i * size] = mask.getX(i);
    fin[i * size + 1] = Math.round(id.getX(i));
    if (leg !== undefined) fin[i * size + 2] = Math.round(leg.getX(i));
  }
  geometry.setAttribute(FIN_ATTRIBUTE, new BufferAttribute(fin, size));
  const index = source.getIndex();
  if (index !== null) geometry.setIndex(Array.from(index.array as ArrayLike<number>));
  mesh.updateWorldMatrix(true, false);
  geometry.applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The hip of each leg: the centroid of its vertices nearest the root, where the limb weight is
 * lowest. The legs swing rigidly about it, so a step neither stretches nor bulges the tube.
 */
export function legPivots(geometry: BufferGeometry, legCount: number): (Vec3 | null)[] {
  const fin = geometry.getAttribute(FIN_ATTRIBUTE);
  const position = geometry.getAttribute('position');
  if (fin.itemSize !== 3) throw new Error('legPivots: the geometry has no packed _leg attribute');
  const lowest = new Array<number>(legCount).fill(Infinity);
  for (let i = 0; i < fin.count; i++) {
    const leg = fin.getZ(i);
    if (fin.getY(i) === LEG_PART_ID && leg >= 0 && leg < legCount) {
      lowest[leg] = Math.min(lowest[leg] ?? Infinity, fin.getX(i));
    }
  }
  const sums = Array.from({ length: legCount }, () => [0, 0, 0, 0]);
  for (let i = 0; i < fin.count; i++) {
    const sum = sums[fin.getZ(i)];
    const floor = lowest[fin.getZ(i)];
    if (fin.getY(i) !== LEG_PART_ID || sum === undefined || floor === undefined) continue;
    if (fin.getX(i) > floor + HIP_WEIGHT_SLACK) continue;
    sum[0] = (sum[0] ?? 0) + position.getX(i);
    sum[1] = (sum[1] ?? 0) + position.getY(i);
    sum[2] = (sum[2] ?? 0) + position.getZ(i);
    sum[3] = (sum[3] ?? 0) + 1;
  }
  return sums.map(([x = 0, y = 0, z = 0, n = 0]) => (n > 0 ? [x / n, y / n, z / n] : null));
}

function standardMaterial(material: Material | Material[], label: string): MeshStandardMaterial {
  if (Array.isArray(material) || !(material instanceof MeshStandardMaterial)) {
    throw new Error(`${label}: expected one glTF PBR material per primitive`);
  }
  return material;
}

function textures(material: MeshStandardMaterial): Texture[] {
  return Object.values(material).filter((v): v is Texture => v instanceof Texture);
}

/** Frees a glTF scene that never became a LOD; it only references its own materials. */
function disposeScene(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials: Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      if (material instanceof MeshStandardMaterial) {
        for (const texture of textures(material)) texture.dispose();
      }
      material.dispose();
    }
  });
}

/** Groups a LOD's primitives by material and merges each group into one geometry. */
function collectParts(
  root: Object3D,
  label: string,
  shared: Map<string, MeshStandardMaterial>,
  legCount: number,
): FishPart[] {
  const earlier = new Map(shared);
  const groups = new Map<MeshStandardMaterial, BufferGeometry[]>();
  const unused = new Set<MeshStandardMaterial>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const own = standardMaterial(object.material, label);
    const material = (own.name !== '' ? earlier.get(own.name) : undefined) ?? own;
    if (material !== own) unused.add(own);
    else if (own.name !== '' && !shared.has(own.name)) shared.set(own.name, own);
    const list = groups.get(material) ?? [];
    list.push(prepareFishGeometry(object, label, legCount > 0));
    groups.set(material, list);
  });
  const keep = new Set(groups.keys());
  for (const material of unused) {
    for (const texture of textures(material)) {
      if (![...keep].some((k) => textures(k).includes(texture))) texture.dispose();
    }
    material.dispose();
  }
  if (groups.size === 0) throw new Error(`${label}: no meshes in the file`);
  return [...groups].map(([source, geometries]) => {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (merged === undefined || merged === null) {
      throw new Error(`${label}: primitives sharing "${source.name}" could not be merged`);
    }
    if (geometries.length > 1) for (const g of geometries) g.dispose();
    return {
      geometry: merged,
      source,
      legPivots: legCount > 0 ? legPivots(merged, legCount) : [],
    };
  });
}

/**
 * The GLBs reference the 1k maps. At 2048 a second GLTFLoader swaps in each map's 2k file, by
 * exact URL and only where the 2k file is larger, so the shared KTX2 loader is never switched.
 */
export class FishAssetLoader {
  private readonly gltf: GLTFLoader;
  private readonly sharpGltf: GLTFLoader;
  private readonly sharper = new Map<string, string>();
  private index: Promise<Map<string, FishAssetEntry>> | null = null;
  /** Applies to loads started after it changes. */
  textureSize: FishTextureSize = 1024;

  /** `ktx2` is the renderer's shared loader; this loader never disposes it. */
  constructor(
    ktx2: Ktx2Textures,
    private readonly root: string,
  ) {
    this.gltf = new GLTFLoader()
      .setKTX2Loader(gltfKtx2Loader(ktx2))
      .setMeshoptDecoder(MeshoptDecoder);
    this.sharpGltf = new GLTFLoader()
      .setKTX2Loader(rewritingKtx2Loader(ktx2, (url) => this.sharper.get(url) ?? url))
      .setMeshoptDecoder(MeshoptDecoder);
  }

  entries(): Promise<Map<string, FishAssetEntry>> {
    this.index ??= fetch(`${this.root}index.json`).then(async (response) => {
      if (!response.ok) {
        throw new Error(`assets/index.json: HTTP ${response.status}; is public/assets deployed?`);
      }
      const entries = parseFishAssets(await response.json());
      for (const entry of entries.values()) {
        for (const [small, large] of entry.sharperTextures) {
          this.sharper.set(`${this.root}${small}`, `${this.root}${large}`);
        }
      }
      return entries;
    });
    return this.index;
  }

  /** The size a load of `entry` gets now; a model with no larger 2k map always gets 1024. */
  textureSizeFor(entry: FishAssetEntry): FishTextureSize {
    return entry.sharperTextures.size > 0 ? this.textureSize : 1024;
  }

  async load(assetId: string): Promise<FishModel> {
    const entry = (await this.entries()).get(assetId);
    if (entry === undefined) throw new Error(`fish asset "${assetId}" is not in assets/index.json`);
    const textureSize = this.textureSizeFor(entry);
    const gltfLoader = textureSize === 2048 ? this.sharpGltf : this.gltf;
    const shared = new Map<string, MeshStandardMaterial>();
    const lods: FishPart[][] = [];
    try {
      for (const file of entry.lodFiles) {
        const gltf = await gltfLoader.loadAsync(`${this.root}${file}`);
        try {
          const legCount = (entry.shrimp?.legPairs ?? 0) * 2;
          lods.push(collectParts(gltf.scene, `fish ${file}`, shared, legCount));
        } catch (cause) {
          disposeScene(gltf.scene);
          throw cause;
        }
      }
    } catch (cause) {
      disposeFishModel({ entry, textureSize, lods });
      throw cause;
    }
    return { entry, textureSize, lods };
  }
}

export function disposeFishModel(model: FishModel): void {
  const materials = new Set<MeshStandardMaterial>();
  for (const parts of model.lods) {
    for (const part of parts) {
      part.geometry.dispose();
      materials.add(part.source);
    }
  }
  for (const material of materials) {
    for (const texture of textures(material)) texture.dispose();
    material.dispose();
  }
}
