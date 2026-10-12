import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Texture,
  type InterleavedBufferAttribute,
  type Material,
  type WebGPURenderer,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { parseFishAssets, type FishAssetEntry } from './assetIndex';

/** One draw per material: the merged primitives of a LOD that share it. */
export interface FishPart {
  readonly geometry: BufferGeometry;
  readonly source: MeshStandardMaterial;
}

export interface FishModel {
  readonly entry: FishAssetEntry;
  /** `lods[level]` holds that level's parts; every level reuses lod0's materials where it can. */
  readonly lods: readonly (readonly FishPart[])[];
}

/** `_fin_mask` and `_fin_id` share one vec2 so the fish stay within WebGPU's 8 vertex buffers. */
export const FIN_ATTRIBUTE = 'fin';
const KEPT_ATTRIBUTES = ['position', 'normal', 'uv'] as const;

function toFloat32(attribute: BufferAttribute | InterleavedBufferAttribute): BufferAttribute {
  const { count, itemSize } = attribute;
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < itemSize; c++) out[i * itemSize + c] = attribute.getComponent(i, c);
  }
  return new BufferAttribute(out, itemSize);
}

/** Bakes the node transform and repacks the fin attributes; the result is unquantised float32. */
export function prepareFishGeometry(mesh: Mesh, label: string): BufferGeometry {
  const source = mesh.geometry;
  const mask = source.getAttribute('_fin_mask');
  const id = source.getAttribute('_fin_id');
  if (mask === undefined || id === undefined) {
    throw new Error(`${label}: _FIN_MASK/_FIN_ID attributes missing; re-run the asset pipeline`);
  }
  const geometry = new BufferGeometry();
  for (const name of KEPT_ATTRIBUTES) {
    const attribute = source.getAttribute(name);
    if (attribute === undefined) throw new Error(`${label}: vertex attribute "${name}" missing`);
    geometry.setAttribute(name, toFloat32(attribute));
  }
  const fin = new Float32Array(mask.count * 2);
  for (let i = 0; i < mask.count; i++) {
    fin[i * 2] = mask.getX(i);
    fin[i * 2 + 1] = Math.round(id.getX(i));
  }
  geometry.setAttribute(FIN_ATTRIBUTE, new BufferAttribute(fin, 2));
  const index = source.getIndex();
  if (index !== null) geometry.setIndex(Array.from(index.array as ArrayLike<number>));
  mesh.updateWorldMatrix(true, false);
  geometry.applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingSphere();
  return geometry;
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
    list.push(prepareFishGeometry(object, label));
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
    return { geometry: merged, source };
  });
}

export class FishAssetLoader {
  private readonly gltf: GLTFLoader;
  private readonly ktx2: KTX2Loader;
  private index: Promise<Map<string, FishAssetEntry>> | null = null;

  constructor(
    renderer: WebGPURenderer,
    private readonly root: string,
  ) {
    this.ktx2 = new KTX2Loader().detectSupport(renderer);
    this.gltf = new GLTFLoader().setKTX2Loader(this.ktx2).setMeshoptDecoder(MeshoptDecoder);
  }

  entries(): Promise<Map<string, FishAssetEntry>> {
    this.index ??= fetch(`${this.root}index.json`).then(async (response) => {
      if (!response.ok) {
        throw new Error(`assets/index.json: HTTP ${response.status}; is public/assets deployed?`);
      }
      return parseFishAssets(await response.json());
    });
    return this.index;
  }

  async load(assetId: string): Promise<FishModel> {
    const entry = (await this.entries()).get(assetId);
    if (entry === undefined) throw new Error(`fish asset "${assetId}" is not in assets/index.json`);
    const shared = new Map<string, MeshStandardMaterial>();
    const lods: FishPart[][] = [];
    try {
      for (const file of entry.lodFiles) {
        const gltf = await this.gltf.loadAsync(`${this.root}${file}`);
        try {
          lods.push(collectParts(gltf.scene, `fish ${file}`, shared));
        } catch (cause) {
          disposeScene(gltf.scene);
          throw cause;
        }
      }
    } catch (cause) {
      disposeFishModel({ entry, lods });
      throw cause;
    }
    return { entry, lods };
  }

  dispose(): void {
    this.ktx2.dispose();
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
