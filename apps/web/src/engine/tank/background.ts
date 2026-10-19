import {
  backgroundIdSchema,
  DEFAULT_BACKGROUND_ID,
  isBackgroundForBiome,
  isPlayableBiome,
  type BackgroundId,
  type Biome,
} from '@aquarium/shared';
import { Color, DataTexture, SRGBColorSpace, type Texture, type TextureNode } from 'three/webgpu';
import { texture } from 'three/tsl';
import { TIERS, type Tier } from '../quality/tiers';

/** Linear albedo of the plain dark blue film shown while no picture is loaded, or none exists. */
export const BACKDROP_FILM = new Color(0.01, 0.025, 0.08);

export type BackgroundFiles = ReadonlyMap<BackgroundId, Readonly<Record<Tier, string>>>;

/** The tank's own background if it belongs to `biome`, else the biome's default; null for a biome without any. */
export function pickBackgroundId(biome: Biome, id: string | null): BackgroundId | null {
  if (!isPlayableBiome(biome)) return null;
  if (id !== null && isBackgroundForBiome(biome, id)) return id;
  return DEFAULT_BACKGROUND_ID[biome];
}

function fail(path: string, expected: string): never {
  throw new TypeError(`assets/index.json: ${path} must be ${expected}; re-run the asset pipeline`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object');
  return value as Record<string, unknown>;
}

/** Paths are joined to the assets root, so anything climbing out of it is rejected. */
function ktx2Path(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.startsWith('/') ||
    value.split('/').includes('..') ||
    !value.endsWith('.ktx2')
  ) {
    fail(path, 'a relative .ktx2 path inside the assets folder');
  }
  return value;
}

/**
 * The per-tier picture of every background in the asset index that the shared contract knows.
 * Tiers whose files are identical share the lowest tier's path.
 */
export function parseBackgroundFiles(json: unknown): BackgroundFiles {
  const assets = record(json, 'root').assets;
  if (!Array.isArray(assets)) fail('assets', 'an array');
  const out = new Map<BackgroundId, Record<Tier, string>>();
  assets.forEach((raw: unknown, i) => {
    const asset = record(raw, `assets[${i}]`);
    if (asset.kind !== 'background') return;
    const id = backgroundIdSchema.safeParse(asset.id);
    if (!id.success) return;
    const at = `assets[${id.data}].background.tiers`;
    const tiers = record(record(asset.background, `assets[${id.data}].background`).tiers, at);
    const files = {} as Record<Tier, string>;
    const byHash = new Map<string, string>();
    for (const tier of TIERS) {
      const entry = record(tiers[tier], `${at}.${tier}`);
      const path = ktx2Path(entry.file, `${at}.${tier}.file`);
      const hash = typeof entry.sha256 === 'string' ? entry.sha256 : path;
      // High and ultra ship one picture under two names; one name means one download.
      const first = byHash.get(hash) ?? path;
      byHash.set(hash, first);
      files[tier] = first;
    }
    out.set(id.data, files);
  });
  return out;
}

export function backgroundFile(files: BackgroundFiles, id: BackgroundId, tier: Tier): string {
  const entry = files.get(id);
  if (entry === undefined) {
    throw new Error(`Background "${id}" is not in assets/index.json; re-run the asset pipeline`);
  }
  return entry[tier];
}

function filmTexture(): DataTexture {
  const srgb = BACKDROP_FILM.clone().convertLinearToSRGB();
  const texel = new Uint8Array([srgb.r, srgb.g, srgb.b, 1].map((c) => Math.round(c * 255)));
  const film = new DataTexture(texel, 1, 1);
  film.colorSpace = SRGBColorSpace;
  film.name = 'backdrop-film';
  film.needsUpdate = true;
  return film;
}

export interface BackgroundLoader {
  loadAsync(url: string): Promise<Texture>;
}

export interface TankBackgroundOptions {
  /** Folder holding `index.json` and the pictures, with a trailing slash. */
  readonly assetRoot: string;
  readonly fetchIndex: () => Promise<unknown>;
}

/**
 * The picture behind the back glass. `map` keeps its node for the life of the tank and only its
 * texture changes, so a new picture or tier never rebuilds a pipeline. One picture is alive at a
 * time: the one it replaces is freed as it goes in, and a load nobody wants by the time it lands
 * is freed at once.
 */
export class TankBackground {
  readonly map: TextureNode;
  private readonly film = filmTexture();
  private wanted: BackgroundId | null = null;
  private currentTier: Tier;
  private shown: { readonly file: string; readonly texture: Texture } | null = null;
  private files: BackgroundFiles | null = null;
  private filesLoad: Promise<BackgroundFiles> | null = null;
  private readonly loads = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly loader: BackgroundLoader,
    tier: Tier,
    private readonly options: TankBackgroundOptions,
  ) {
    this.currentTier = tier;
    this.map = texture(this.film);
  }

  /** The background asked for last, after the fallback; null shows the plain film. */
  get id(): BackgroundId | null {
    return this.wanted;
  }

  get tier(): Tier {
    return this.currentTier;
  }

  /** The asset file drawn now, relative to the assets root; null while the film shows. */
  get file(): string | null {
    return this.shown?.file ?? null;
  }

  /**
   * Shows `id`, or the biome's default when it is null or not one of the biome's. Resolves once
   * that picture is drawn, or once a later call has taken over.
   */
  show(biome: Biome, id: string | null): Promise<void> {
    this.assertLive('show');
    this.wanted = pickBackgroundId(biome, id);
    return this.refresh();
  }

  setTier(tier: Tier): Promise<void> {
    this.assertLive('setTier');
    if (tier === this.currentTier) return Promise.resolve();
    this.currentTier = tier;
    return this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.swap(null);
    this.film.dispose();
  }

  private assertLive(what: string): void {
    if (this.disposed) throw new Error(`TankBackground: ${what}() after dispose()`);
  }

  private async refresh(): Promise<void> {
    if (this.wanted !== null) await this.index();
    const file = this.wantedFile();
    if (file === undefined) return;
    if (file === null) {
      this.swap(null);
      return;
    }
    if (this.shown?.file === file) return;
    await this.load(file);
  }

  /** Undefined until the index is in, or after dispose. */
  private wantedFile(): string | null | undefined {
    if (this.disposed) return undefined;
    if (this.wanted === null) return null;
    if (this.files === null) return undefined;
    return backgroundFile(this.files, this.wanted, this.currentTier);
  }

  private index(): Promise<BackgroundFiles> {
    this.filesLoad ??= this.options.fetchIndex().then(
      (json) => {
        this.files = parseBackgroundFiles(json);
        return this.files;
      },
      (cause: unknown) => {
        this.filesLoad = null;
        throw cause;
      },
    );
    return this.filesLoad;
  }

  /** One download per file however often it is asked for while in flight. */
  private load(file: string): Promise<void> {
    const pending = this.loads.get(file);
    if (pending) return pending;
    const url = `${this.options.assetRoot}${file}`;
    const load = this.loader.loadAsync(url).then(
      (loaded) => {
        this.loads.delete(file);
        if (this.wantedFile() !== file) {
          loaded.dispose();
          return;
        }
        this.swap({ file, texture: loaded });
      },
      (cause: unknown) => {
        this.loads.delete(file);
        // A wrong picture left up (another biome's) is worse than the plain film.
        if (this.wantedFile() === file) this.swap(null);
        throw new Error(`Could not load the tank background ${url}`, { cause });
      },
    );
    this.loads.set(file, load);
    return load;
  }

  private swap(next: { readonly file: string; readonly texture: Texture } | null): void {
    const old = this.shown;
    this.shown = next;
    this.map.value = next?.texture ?? this.film;
    if (old !== null && old.texture !== next?.texture) old.texture.dispose();
  }
}
