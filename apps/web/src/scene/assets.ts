import {
  BufferGeometry,
  CompressedTexture,
  LoadingManager,
  type Object3D,
  RepeatWrapping,
  Texture,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type WebGPURenderer,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import basisTranscoderJs from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisTranscoderWasm from 'three/addons/libs/basis/basis_transcoder.wasm?url';

export const ASSET_BASE = `${import.meta.env.BASE_URL}assets/`;

export type AssetKind =
  'fish' | 'plant' | 'coral' | 'anemone' | 'driftwood' | 'rock' | 'decor' | 'substrate' | 'hdri';

export interface CatalogEntry {
  readonly id: string;
  readonly kind: AssetKind;
  readonly lods: readonly { readonly file: string }[];
  readonly bounds?: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly textures?: readonly {
    readonly role: string;
    readonly variants: Readonly<Record<string, { readonly file: string }>>;
  }[];
}

export class AssetCatalog {
  private readonly byId = new Map<string, CatalogEntry>();

  constructor(entries: readonly CatalogEntry[]) {
    for (const entry of entries) this.byId.set(entry.id, entry);
  }

  static async fetch(url = `${ASSET_BASE}index.json`): Promise<AssetCatalog> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Asset index ${url} returned HTTP ${response.status}; run pnpm build:assets`);
    }
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      !('assets' in body) ||
      !Array.isArray(body.assets)
    ) {
      throw new Error(`Asset index ${url} has no "assets" array`);
    }
    return new AssetCatalog(body.assets as CatalogEntry[]);
  }

  get(id: string): CatalogEntry {
    const entry = this.byId.get(id);
    if (!entry)
      throw new Error(`Unknown asset "${id}"; check content/presets against assets/index.json`);
    return entry;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  entries(): IterableIterator<CatalogEntry> {
    return this.byId.values();
  }
}

/** Points the transcoder at the bundled copy and picks the 1k or 2k variant of every texture. */
export function rewriteAssetUrl(url: string, textureSize: 1024 | 2048): string {
  if (url.endsWith('basis_transcoder.js')) return basisTranscoderJs;
  if (url.endsWith('basis_transcoder.wasm')) return basisTranscoderWasm;
  if (textureSize === 2048) return url.replace(/_1k\.ktx2(\?.*)?$/, '_2k.ktx2$1');
  return url;
}

export interface LoadedPrimitive {
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardMaterial;
}

export interface LoadedModel {
  readonly primitives: readonly LoadedPrimitive[];
}

function isMesh(object: Object3D): object is Mesh {
  return (object as Mesh).isMesh === true;
}

export type ModelLod = 0 | 1 | 2;

/** Satisfies GLTFLoader's required KHR_texture_basisu hook without fetching or transcoding anything. */
class SkipKTX2Loader extends KTX2Loader {
  override load(_url: string, onLoad: (texture: CompressedTexture) => void): void {
    onLoad(new CompressedTexture([], 1, 1));
  }
}

/** One GLTF + KTX2 + meshopt pipeline, caching every (asset, lod, texture size) it loads. */
export class ModelLibrary {
  private readonly manager = new LoadingManager();
  private readonly ktx2 = new KTX2Loader(this.manager);
  private readonly gltf = new GLTFLoader(this.manager);
  private readonly geometryGltf = new GLTFLoader().setKTX2Loader(new SkipKTX2Loader());
  private readonly cache = new Map<string, Promise<LoadedModel>>();
  private readonly finished = new Map<string, LoadedModel>();
  private readonly collision = new Map<string, Promise<readonly BufferGeometry[]>>();
  private textureSize: 1024 | 2048 = 1024;
  private readonly textures: Texture[] = [];
  private inflight = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(
    renderer: WebGPURenderer,
    readonly catalog: AssetCatalog,
  ) {
    this.manager.setURLModifier((url) => rewriteAssetUrl(url, this.textureSize));
    this.ktx2.setTranscoderPath('basis/');
    this.ktx2.detectSupport(renderer);
    this.gltf.setKTX2Loader(this.ktx2);
    this.gltf.setMeshoptDecoder(MeshoptDecoder);
    this.geometryGltf.setMeshoptDecoder(MeshoptDecoder);
  }

  private lodFile(assetId: string, lod: ModelLod): string {
    const entry = this.catalog.get(assetId);
    const lodEntry = entry.lods[lod] ?? entry.lods[entry.lods.length - 1];
    if (!lodEntry) throw new Error(`Asset "${assetId}" has no LODs`);
    return lodEntry.file;
  }

  modelKey(assetId: string, lod: ModelLod, textureSize: 1024 | 2048): string {
    return `${this.lodFile(assetId, lod)}@${textureSize}`;
  }

  load(assetId: string, lod: ModelLod, textureSize: 1024 | 2048): Promise<LoadedModel> {
    const file = this.lodFile(assetId, lod);
    const key = `${file}@${textureSize}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.enter(textureSize)
        .then(() => this.gltf.loadAsync(`${ASSET_BASE}${file}`))
        .finally(() => this.leave())
        .then((gltf) => {
          gltf.scene.updateMatrixWorld(true);
          const primitives: LoadedPrimitive[] = [];
          gltf.scene.traverse((object) => {
            if (!isMesh(object)) return;
            const geometry = object.geometry.clone();
            geometry.applyMatrix4(object.matrixWorld);
            const material = Array.isArray(object.material) ? object.material[0] : object.material;
            if (!material) throw new Error(`${file}: mesh without a material`);
            primitives.push({ geometry, material: material as MeshStandardMaterial });
          });
          if (primitives.length === 0) throw new Error(`${file} contains no meshes`);
          const model = { primitives };
          if (this.cache.get(key) === pending) this.finished.set(key, model);
          return model;
        });
      this.cache.set(key, pending);
      pending.catch(() => this.cache.delete(key));
    }
    return pending;
  }

  /** Geometry of the cheapest LOD, so every client fits identical colliders whatever its tier. Fetches no textures. */
  collisionGeometry(assetId: string): Promise<readonly BufferGeometry[]> {
    let pending = this.collision.get(assetId);
    if (!pending) {
      const entry = this.catalog.get(assetId);
      const file = this.lodFile(assetId, Math.min(2, entry.lods.length - 1) as ModelLod);
      const model = this.finishedRenderModel(file);
      pending = model
        ? Promise.resolve(model.primitives.map((p) => p.geometry.clone()))
        : this.geometryGltf.loadAsync(`${ASSET_BASE}${file}`).then((gltf) => {
            gltf.scene.updateMatrixWorld(true);
            const geometries: BufferGeometry[] = [];
            gltf.scene.traverse((object) => {
              if (!isMesh(object)) return;
              const geometry = object.geometry.clone();
              geometry.applyMatrix4(object.matrixWorld);
              geometries.push(geometry);
            });
            if (geometries.length === 0) throw new Error(`${file} contains no meshes`);
            return geometries;
          });
      this.collision.set(assetId, pending);
      pending.catch(() => this.collision.delete(assetId));
    }
    return pending;
  }

  /** Only a finished render load is reused: waiting on an in-flight one would also wait for its texture decode. */
  private finishedRenderModel(file: string): LoadedModel | undefined {
    for (const [key, model] of this.finished) {
      if (key.startsWith(`${file}@`)) return model;
    }
    return undefined;
  }

  async loadTexture(
    assetId: string,
    role: string,
    textureSize: 1024 | 2048,
    anisotropy: number,
  ): Promise<Texture> {
    const variant = this.catalog.get(assetId).textures?.find((t) => t.role === role)?.variants[
      textureSize === 2048 ? '2k' : '1k'
    ];
    if (!variant) throw new Error(`Asset "${assetId}" has no ${role} texture`);
    await this.enter(textureSize);
    try {
      const texture = await this.ktx2.loadAsync(`${ASSET_BASE}${variant.file}`);
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.anisotropy = anisotropy;
      this.textures.push(texture);
      return texture;
    } finally {
      this.leave();
    }
  }

  /** The URL modifier is global to the manager, so loads of different texture sizes take turns. */
  private async enter(size: 1024 | 2048): Promise<void> {
    while (this.inflight > 0 && this.textureSize !== size) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
    this.textureSize = size;
    this.inflight++;
  }

  private leave(): void {
    if (--this.inflight > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Frees every cached model whose key is not in `keep`, so a tier change drops the old tier's set. */
  async retainOnly(keep: ReadonlySet<string>): Promise<void> {
    const stale = [...this.cache].filter(([key]) => !keep.has(key));
    for (const [key] of stale) {
      this.cache.delete(key);
      this.finished.delete(key);
    }
    const settled = await Promise.allSettled(stale.map(([, pending]) => pending));
    const resources = new Set<Texture | Material | BufferGeometry>();
    for (const result of settled) {
      if (result.status === 'fulfilled') collectResources(result.value, resources);
    }
    for (const resource of resources) resource.dispose();
  }

  /** Frees one texture loaded through `loadTexture`. */
  releaseTexture(texture: Texture): void {
    const index = this.textures.indexOf(texture);
    if (index >= 0) this.textures.splice(index, 1);
    texture.dispose();
  }

  async dispose(): Promise<void> {
    const models = await Promise.allSettled(this.cache.values());
    const seen = new Set<Texture | Material | BufferGeometry>();
    for (const result of models) {
      if (result.status === 'fulfilled') collectResources(result.value, seen);
    }
    for (const item of seen) item.dispose();
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
    this.cache.clear();
    this.finished.clear();
    const collision = await Promise.allSettled(this.collision.values());
    for (const result of collision) {
      if (result.status === 'fulfilled') for (const geometry of result.value) geometry.dispose();
    }
    this.collision.clear();
    this.ktx2.dispose();
  }
}

function collectResources(model: LoadedModel, out: Set<Texture | Material | BufferGeometry>): void {
  for (const { geometry, material } of model.primitives) {
    out.add(geometry);
    out.add(material);
    for (const value of Object.values(material)) if (value instanceof Texture) out.add(value);
  }
}
