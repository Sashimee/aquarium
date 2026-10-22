import {
  BufferGeometry,
  CompressedTexture,
  type Object3D,
  RepeatWrapping,
  Texture,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { rewritingKtx2Loader, type Ktx2Textures } from '../engine/ktx2';
import { sharperTextures } from '../fish/assetIndex';

export const ASSET_BASE = `${import.meta.env.BASE_URL}assets/`;

export type AssetKind =
  | 'fish'
  | 'shrimp'
  | 'plant'
  | 'coral'
  | 'anemone'
  | 'driftwood'
  | 'rock'
  | 'decor'
  | 'substrate'
  | 'hdri';

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
    readonly variants: Readonly<
      Record<string, { readonly file: string; readonly size?: number } | undefined>
    >;
  }[];
}

export class AssetCatalog {
  private readonly byId = new Map<string, CatalogEntry>();
  /** Per asset, 1k map → its 2k map where the 2k really is larger; paths relative to the assets root. */
  private readonly sharper = new Map<string, ReadonlyMap<string, string>>();
  /** The same pairs as URLs under ASSET_BASE, for rewriting what a GLB references. */
  private readonly sharperUrls = new Map<string, string>();

  constructor(entries: readonly CatalogEntry[]) {
    for (const entry of entries) {
      this.byId.set(entry.id, entry);
      const pairs = sharperTextures(entry.textures, `assets[${entry.id}].textures`);
      this.sharper.set(entry.id, pairs);
      for (const [small, large] of pairs) {
        this.sharperUrls.set(`${ASSET_BASE}${small}`, `${ASSET_BASE}${large}`);
      }
    }
  }

  static async fetch(url = `${ASSET_BASE}index.json`, signal?: AbortSignal): Promise<AssetCatalog> {
    const response = await fetch(url, signal ? { signal } : undefined);
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

  /** The size a load of `assetId` really gets: one with no larger 2k map is the same at 2048. */
  textureSizeFor(assetId: string, textureSize: 1024 | 2048): 1024 | 2048 {
    this.get(assetId);
    return (this.sharper.get(assetId)?.size ?? 0) > 0 ? textureSize : 1024;
  }

  /** The 2k file of the `role` map at 2048 where the index lists a larger one, else the 1k file. */
  textureFile(assetId: string, role: string, textureSize: 1024 | 2048): string | undefined {
    const small = this.get(assetId).textures?.find((t) => t.role === role)?.variants['1k']?.file;
    if (small === undefined || textureSize === 1024) return small;
    return this.sharper.get(assetId)?.get(small) ?? small;
  }

  /** Swaps a GLB's 1k map URL for the 2k one at 2048, only where the index lists a larger 2k. */
  materialTextureUrl(url: string, textureSize: 1024 | 2048): string {
    if (textureSize === 1024) return url;
    const query = url.indexOf('?');
    const path = query < 0 ? url : url.slice(0, query);
    const large = this.sharperUrls.get(path);
    return large === undefined ? url : `${large}${query < 0 ? '' : url.slice(query)}`;
  }
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
  private readonly ktx2: KTX2Loader;
  private readonly gltf = new GLTFLoader();
  private readonly geometryGltf = new GLTFLoader().setKTX2Loader(new SkipKTX2Loader());
  private readonly cache = new Map<string, Promise<LoadedModel>>();
  private readonly finished = new Map<string, LoadedModel>();
  private readonly collision = new Map<string, Promise<readonly BufferGeometry[]>>();
  private textureSize: 1024 | 2048 = 1024;
  private readonly textures: Texture[] = [];
  private inflight = 0;
  private idleWaiters: (() => void)[] = [];

  /** `ktx2` is the renderer's shared loader; the library never disposes it. */
  constructor(
    ktx2: Ktx2Textures,
    readonly catalog: AssetCatalog,
  ) {
    this.ktx2 = rewritingKtx2Loader(ktx2, (url) =>
      catalog.materialTextureUrl(url, this.textureSize),
    );
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
    return `${this.lodFile(assetId, lod)}@${this.catalog.textureSizeFor(assetId, textureSize)}`;
  }

  load(assetId: string, lod: ModelLod, requestedSize: 1024 | 2048): Promise<LoadedModel> {
    const file = this.lodFile(assetId, lod);
    const textureSize = this.catalog.textureSizeFor(assetId, requestedSize);
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
    const file = this.catalog.textureFile(assetId, role, textureSize);
    if (file === undefined) throw new Error(`Asset "${assetId}" has no ${role} texture`);
    await this.enter(textureSize);
    try {
      const texture = await this.ktx2.loadAsync(`${ASSET_BASE}${file}`);
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.anisotropy = anisotropy;
      this.textures.push(texture);
      return texture;
    } finally {
      this.leave();
    }
  }

  /** The texture variant is chosen per library, not per load, so loads of different texture sizes take turns. */
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
    await this.pruneCollision(keep);
  }

  private async pruneCollision(keep: ReadonlySet<string>): Promise<void> {
    const files = new Set([...keep].map((key) => key.slice(0, key.lastIndexOf('@'))));
    const stale = [...this.collision].filter(([assetId]) => {
      const { lods } = this.catalog.get(assetId);
      return !lods.some((lod) => files.has(lod.file));
    });
    for (const [assetId] of stale) this.collision.delete(assetId);
    const settled = await Promise.allSettled(stale.map(([, pending]) => pending));
    for (const result of settled) {
      if (result.status === 'fulfilled') for (const geometry of result.value) geometry.dispose();
    }
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
  }
}

function collectResources(model: LoadedModel, out: Set<Texture | Material | BufferGeometry>): void {
  for (const { geometry, material } of model.primitives) {
    out.add(geometry);
    out.add(material);
    for (const value of Object.values(material)) if (value instanceof Texture) out.add(value);
  }
}
