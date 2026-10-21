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
import { parseFishAssets, type FishAssetEntry, type ShrimpRig } from './assetIndex';
import { MOUTH_LODS } from './lod';
import { curledTip, MAX_TAIL_CURL, type TailRig, type TailTip } from './walk';

/** One draw per material: the merged primitives of a LOD that share it. */
export interface FishPart {
  readonly geometry: BufferGeometry;
  readonly source: MeshStandardMaterial;
  /** A walker's hip for each `_leg` index, null where this LOD has no such leg; empty for a fish. */
  readonly legPivots: readonly (Vec3 | null)[];
  /** The fin attribute of a fish carries the `_mouth` weight as its third component. */
  readonly mouth: boolean;
}

export type Vec3 = readonly [number, number, number];

export type FishTextureSize = 1024 | 2048;

export interface FishModel {
  readonly entry: FishAssetEntry;
  readonly textureSize: FishTextureSize;
  /** `lods[level]` holds that level's parts; every level reuses lod0's materials where it can. */
  readonly lods: readonly (readonly FishPart[])[];
  /** A legged walker's tail-curl rig from lod0; null for a fish or a snail. */
  readonly tail: TailRig | null;
  /** Where a crab or snail withdraws into its shell, from lod0; null for the others. */
  readonly shell: ShellRig | null;
}

/** In model units. */
export interface ShellRig {
  /** Centroid of the shell's vertices; the soft parts shrink towards it as the animal withdraws. */
  readonly centre: Vec3;
  /** Height of the shell's underside over the surface at rest, which it settles by withdrawn. */
  readonly drop: number;
}

/**
 * `_fin_mask` and `_fin_id` share one vec2, and a walker's `_leg` or a fish's `_mouth` makes it a
 * vec3, so the models stay within WebGPU's 8 vertex buffers.
 */
export const FIN_ATTRIBUTE = 'fin';
/** `_fin_id` of a crab's or snail's shell, which stays rigid; every other part is soft. */
export const SHELL_PART_ID = 0;
/** `_fin_id` of a snail's foot; its head and tentacles follow as 11 and 12. */
export const SNAIL_FOOT_PART_ID = 10;
/** `_fin_id` of a shrimp's walking legs and chelipeds. */
export const LEG_PART_ID = 6;
/** `_fin_id` of a shrimp's pleopods and of its abdomen with the tail fan: the parts that curl. */
export const PLEOPOD_PART_ID = 8;
export const ABDOMEN_PART_ID = 9;
/** Hip vertices sit at the minimum limb weight; the simplified LODs may shift it slightly. */
const HIP_WEIGHT_SLACK = 0.02;
const KEPT_ATTRIBUTES = ['position', 'normal', 'uv'] as const;
const MOUTH_SOURCE = '_mouth';

function toFloat32(attribute: BufferAttribute | InterleavedBufferAttribute): BufferAttribute {
  const { count, itemSize } = attribute;
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < itemSize; c++) out[i * itemSize + c] = attribute.getComponent(i, c);
  }
  return new BufferAttribute(out, itemSize);
}

/**
 * Bakes the node transform and repacks the fin attributes, with `_leg` when `limbs`, or else with
 * `_mouth` when `mouth`, 0 where the mesh has none; the result is unquantised float32.
 */
export function prepareFishGeometry(
  mesh: Mesh,
  label: string,
  limbs = false,
  mouth = false,
): BufferGeometry {
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
  const jaw = !limbs && mouth ? source.getAttribute(MOUTH_SOURCE) : undefined;
  const size = limbs || mouth ? 3 : 2;
  const fin = new Float32Array(mask.count * size);
  for (let i = 0; i < mask.count; i++) {
    fin[i * size] = mask.getX(i);
    fin[i * size + 1] = Math.round(id.getX(i));
    if (leg !== undefined) fin[i * size + 2] = Math.round(leg.getX(i));
    if (jaw !== undefined) fin[i * size + 2] = jaw.getX(i);
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

/**
 * The curling vertex that full flexion carries lowest in model space, which is the first to meet
 * the floor under a level body; null when the parts have no curling vertex.
 */
export function tailTip(parts: readonly FishPart[], rig: ShrimpRig): TailTip | null {
  const span = rig.hinge.z - rig.telsonZ;
  let best: TailTip | null = null;
  let lowest = Infinity;
  for (const { geometry } of parts) {
    const fin = geometry.getAttribute(FIN_ATTRIBUTE);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < fin.count; i++) {
      const id = fin.getY(i);
      if (id !== PLEOPOD_PART_ID && id !== ABDOMEN_PART_ID) continue;
      const z = position.getZ(i);
      const tip = {
        y: position.getY(i),
        z,
        share: Math.min(1, Math.max(0, (rig.hinge.z - z) / span)),
      };
      const curled = curledTip({ hinge: rig.hinge, tip, bodyLength: 1 }, MAX_TAIL_CURL).y;
      if (curled < lowest) {
        lowest = curled;
        best = tip;
      }
    }
  }
  return best;
}

function tailRig(entry: FishAssetEntry, lod0: readonly FishPart[]): TailRig | null {
  if (entry.shrimp === null) return null;
  const tip = tailTip(lod0, entry.shrimp);
  if (tip === null) {
    throw new Error(`fish ${entry.id}: lod0 has no abdomen to curl; re-run the asset pipeline`);
  }
  return { hinge: entry.shrimp.hinge, tip, bodyLength: entry.standardLengthM };
}

/** Null for a model that has no shell to withdraw into. */
export function shellRig(entry: FishAssetEntry, lod0: readonly FishPart[]): ShellRig | null {
  if ((entry.kind !== 'crab' && entry.kind !== 'snail') || entry.standoff === null) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  let underside = Infinity;
  for (const { geometry } of lod0) {
    const fin = geometry.getAttribute(FIN_ATTRIBUTE);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < fin.count; i++) {
      if (fin.getY(i) !== SHELL_PART_ID) continue;
      x += position.getX(i);
      y += position.getY(i);
      z += position.getZ(i);
      n += 1;
      underside = Math.min(underside, position.getY(i));
    }
  }
  if (n === 0) throw new Error(`fish ${entry.id}: lod0 has no shell; re-run the asset pipeline`);
  return { centre: [x / n, y / n, z / n], drop: Math.max(0, underside + entry.standoff) };
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

/**
 * Groups a LOD's primitives by material and merges each group into one geometry. A fish group
 * carries the mouth weight when `mouth` and one of its primitives has it.
 */
function collectParts(
  root: Object3D,
  label: string,
  shared: Map<string, MeshStandardMaterial>,
  legCount: number,
  mouth: boolean,
): FishPart[] {
  const earlier = new Map(shared);
  const meshes = new Map<MeshStandardMaterial, Mesh[]>();
  const unused = new Set<MeshStandardMaterial>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const own = standardMaterial(object.material, label);
    const material = (own.name !== '' ? earlier.get(own.name) : undefined) ?? own;
    if (material !== own) unused.add(own);
    else if (own.name !== '' && !shared.has(own.name)) shared.set(own.name, own);
    const list = meshes.get(material) ?? [];
    list.push(object);
    meshes.set(material, list);
  });
  const limbs = legCount > 0;
  const groups = new Map<MeshStandardMaterial, { geometries: BufferGeometry[]; mouth: boolean }>();
  for (const [material, list] of meshes) {
    const moves =
      mouth && !limbs && list.some((m) => m.geometry.getAttribute(MOUTH_SOURCE) !== undefined);
    const geometries = list.map((m) => prepareFishGeometry(m, label, limbs, moves));
    groups.set(material, { geometries, mouth: moves });
  }
  const keep = new Set(groups.keys());
  for (const material of unused) {
    for (const texture of textures(material)) {
      if (![...keep].some((k) => textures(k).includes(texture))) texture.dispose();
    }
    material.dispose();
  }
  if (groups.size === 0) throw new Error(`${label}: no meshes in the file`);
  return [...groups].map(([source, { geometries, mouth: moves }]) => {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (merged === undefined || merged === null) {
      throw new Error(`${label}: primitives sharing "${source.name}" could not be merged`);
    }
    if (geometries.length > 1) for (const g of geometries) g.dispose();
    return {
      geometry: merged,
      source,
      legPivots: limbs ? legPivots(merged, legCount) : [],
      mouth: moves,
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
      for (const [level, file] of entry.lodFiles.entries()) {
        const gltf = await gltfLoader.loadAsync(`${this.root}${file}`);
        try {
          const legCount = (entry.shrimp?.legPairs ?? 0) * 2;
          const mouth = level < MOUTH_LODS;
          lods.push(collectParts(gltf.scene, `fish ${file}`, shared, legCount, mouth));
        } catch (cause) {
          disposeScene(gltf.scene);
          throw cause;
        }
      }
      const lod0 = lods[0] ?? [];
      return { entry, textureSize, lods, tail: tailRig(entry, lod0), shell: shellRig(entry, lod0) };
    } catch (cause) {
      disposeFishModel({ lods });
      throw cause;
    }
  }
}

export function disposeFishModel(model: Pick<FishModel, 'lods'>): void {
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
