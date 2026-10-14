import type { Material, MeshStandardNodeMaterial, Texture } from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { Biome, DecorItem, PlantPatch, PresetLayout } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import type { Tier, TierSettings } from '../engine/quality/tiers';
import { substrateHeight } from '../engine/tank/substrate';
import { AssetCatalog, ModelLibrary, type CatalogEntry, type ModelLod } from './assets';
import {
  AnemoneGroup,
  anemoneAnchor,
  anemoneCollider,
  anemoneReach,
  type SceneAnchor,
} from './anemone';
import {
  EUPHYLLIA_DETAIL,
  EuphylliaGroup,
  euphylliaCollider,
  euphylliaReach,
  generateEuphyllia,
  type EuphylliaMesh,
  parseEuphylliaId,
  type EuphylliaDetail,
  type EuphylliaVariant,
} from './euphyllia';
import { ColliderField, type CapsuleCollider, type Collider } from './colliders';
import { CurrentField, type CurrentParameters } from './current';
import { fluorescenceLevel } from './coralStyle';
import { createCoralGlowNode, fitCollider, Hardscape, HARDSCAPE_KINDS } from './hardscape';
import { applyBiomeLighting } from './lighting';
import type { SceneOptions } from './options';
import { ColliderOverlay } from './overlay';
import { MAX_TILT_RAD as MAX_PLANT_TILT, scatterPatch, type Extent } from './placement';
import { RebuildQueue } from './rebuildQueue';
import {
  PlantGroup,
  maxSway,
  surfaceScaleCeiling,
  SURFACE_MARGIN,
  type PlantEntry,
} from './plants';
import { createSubstrateMaterial, type SubstrateLayers } from './substrate';

const FALLBACK_PLANT_HEIGHT = 0.2;

export const DEFAULT_CURRENT: CurrentParameters = {
  direction: [1, 0],
  speed: 0.04,
  gustPeriodS: 9,
  gustDepth: 0.4,
};

const PLANT_LOD: Readonly<Record<Tier, ModelLod>> = { low: 2, medium: 1, high: 1, ultra: 0 };
const HARDSCAPE_LOD: Readonly<Record<Tier, ModelLod>> = { low: 2, medium: 1, high: 0, ultra: 0 };
const WALL_MARGIN = 0.005;
const BLOCKED_CLEARANCE = 0.005;
const MIN_COLLIDER_PLANT_HEIGHT = 0.15;

interface SubstrateInstall {
  readonly material: MeshStandardNodeMaterial;
  readonly textures: readonly Texture[];
  readonly textureSize: 1024 | 2048;
}

interface EuphylliaItem {
  readonly item: DecorItem;
  readonly variant: EuphylliaVariant;
  readonly seed: number;
  readonly fullDetail?: EuphylliaMesh;
}

interface VisualKey {
  readonly euphylliaDetail: EuphylliaDetail;
  readonly plantLod: ModelLod;
  readonly hardscapeLod: ModelLod;
  readonly textureSize: 1024 | 2048;
}

function keyFor(tier: Tier, settings: Readonly<TierSettings>): VisualKey {
  return {
    euphylliaDetail: EUPHYLLIA_DETAIL[tier],
    plantLod: PLANT_LOD[tier],
    hardscapeLod: HARDSCAPE_LOD[tier],
    textureSize: settings.textureSize,
  };
}

function sameKey(a: VisualKey, b: VisualKey): boolean {
  return (
    a.euphylliaDetail === b.euphylliaDetail &&
    a.plantLod === b.plantLod &&
    a.hardscapeLod === b.hardscapeLod &&
    a.textureSize === b.textureSize
  );
}

/**
 * A planted tank built from a preset: textured substrate, hardscape, instanced swaying plants
 * and the colliders the sim reads. Everything tier-dependent is rebuilt or thinned in `applyTier`.
 */
export class TankScene {
  readonly current = new CurrentField();
  readonly overlay: ColliderOverlay;
  private colliderField: ColliderField;

  private readonly fluorescence = uniform(0);
  private readonly coralGlowNode = createCoralGlowNode(this.fluorescence);
  private hardscape: Hardscape | null = null;
  private anemones: AnemoneGroup[] = [];
  private euphyllias: EuphylliaGroup[] = [];
  private plantGroups: PlantGroup[] = [];
  private installedKey: VisualKey | null = null;
  private readonly queue: RebuildQueue<VisualKey>;
  private substrate: SubstrateInstall | null = null;
  private readonly placeholderSubstrate: Material | Material[];
  private disposed = false;
  private readonly presetHard: readonly DecorItem[];
  private readonly releases: (() => void)[] = [];

  private constructor(
    private readonly engine: Engine,
    private readonly library: ModelLibrary,
    private readonly preset: PresetLayout,
    private colliderData: readonly Collider[],
    /** The leading entries of `colliderData`, fitted to the movable hardscape. */
    private hardColliderCount: number,
    private readonly plantEntries: ReadonlyMap<string, PlantEntry[]>,
    private hardItems: readonly { item: DecorItem; kind: string }[],
    private readonly anemoneItems: readonly DecorItem[],
    private readonly euphylliaItems: readonly EuphylliaItem[],
    private readonly anchorData: readonly SceneAnchor[],
    options: SceneOptions,
  ) {
    this.presetHard = hardItems.map((h) => h.item);
    this.queue = new RebuildQueue(
      sameKey,
      (key, isStale) => this.rebuildVisuals(key, isStale),
      (cause) =>
        engine.events.emit('engine:error', {
          message: 'Could not switch scene models to the new quality tier',
          cause,
        }),
    );
    this.placeholderSubstrate = engine.tank.substrate.material;
    this.colliderField = new ColliderField(colliderData);
    this.overlay = new ColliderOverlay(colliderData);
    this.overlay.visible = options.colliders;
    engine.scene.add(this.overlay.group);
  }

  static async create(
    engine: Engine,
    preset: PresetLayout,
    options: SceneOptions,
  ): Promise<TankScene> {
    const catalog = await AssetCatalog.fetch();
    const library = new ModelLibrary(engine.ktx2, catalog);
    try {
      const scene = await TankScene.build(engine, library, catalog, preset, options);
      return scene;
    } catch (error) {
      await library.dispose();
      throw error;
    }
  }

  private static async build(
    engine: Engine,
    library: ModelLibrary,
    catalog: AssetCatalog,
    preset: PresetLayout,
    options: SceneOptions,
  ): Promise<TankScene> {
    const settings = engine.quality.settings;
    const tier = engine.quality.tier;
    const dimensions = engine.tank.dimensions;

    const hardItems: { item: DecorItem; kind: string }[] = [];
    const layoutPlants: DecorItem[] = [];
    const anemoneItems: DecorItem[] = [];
    const euphylliaItems: EuphylliaItem[] = [];
    for (const item of preset.decor) {
      const procedural = parseEuphylliaId(item.assetId);
      if (procedural) {
        euphylliaItems.push({ item, ...procedural });
        continue;
      }
      const kind = catalog.get(item.assetId).kind;
      if (HARDSCAPE_KINDS.has(kind)) hardItems.push({ item, kind });
      else if (kind === 'plant') layoutPlants.push(item);
      else if (kind === 'anemone') anemoneItems.push(item);
      else throw new Error(`Preset item "${item.assetId}" is a ${kind}, which a tank cannot hold`);
    }
    for (const patch of preset.plantPatches) {
      if (catalog.get(patch.assetId).kind !== 'plant') {
        throw new Error(`Plant patch "${patch.id}" uses ${patch.assetId}, which is not a plant`);
      }
    }
    if (preset.substrate) {
      catalog.get(preset.substrate.assetId);
      if (preset.substrate.accentAssetId) catalog.get(preset.substrate.accentAssetId);
    }

    const colliders: Collider[] = [];
    for (const { item, kind } of hardItems) {
      const geometries = await library.collisionGeometry(item.assetId);
      colliders.push(...fitCollider(kind, geometries, item));
    }
    const hardColliderCount = colliders.length;
    const hard = new ColliderField(colliders);

    const extent = glassExtent(dimensions);
    const waterTop = dimensions.height - dimensions.freeboard;
    const ground = (x: number, z: number) => substrateHeight(dimensions, x, z);
    const normal = new Float64Array(3);
    const blocked = (x: number, y: number, z: number) =>
      hard.hard(x, y + 0.02, z, normal) < BLOCKED_CLEARANCE;

    const plantEntries = new Map<string, PlantEntry[]>();
    const entriesFor = (assetId: string) => {
      let list = plantEntries.get(assetId);
      if (!list) plantEntries.set(assetId, (list = []));
      return list;
    };

    for (const patch of preset.plantPatches) {
      const bounds = catalog.get(patch.assetId).bounds;
      const reach = plantReach(patch.assetId, bounds, preset.current ?? DEFAULT_CURRENT);
      const ceiling = surfaceScaleCeiling(waterTop, bounds?.max[1] ?? FALLBACK_PLANT_HEIGHT);
      const instances = scatterPatch(patch, ground, blocked, extent, reach, ceiling);
      if (instances.length < patch.count) {
        console.warn(
          `Plant patch "${patch.id}" fitted ${instances.length} of ${patch.count} plants; move it clear of hardscape and glass`,
        );
      }
      const list = entriesFor(patch.assetId);
      instances.forEach((instance, i) =>
        list.push({ ...instance, rank: i / Math.max(1, instances.length) }),
      );
      const soft = softPatchCollider(patch, instances, catalog.get(patch.assetId).bounds?.max[1]);
      if (soft) colliders.push(soft);
    }
    for (const item of layoutPlants) {
      entriesFor(item.assetId).push({
        x: item.position[0],
        y: item.position[1],
        z: item.position[2],
        yaw: item.rotationY,
        tiltX: 0,
        tiltZ: 0,
        scale: item.scale,
        tone: 1,
        rank: -1,
      });
      const entry = catalog.get(item.assetId);
      const height = (entry.bounds?.max[1] ?? FALLBACK_PLANT_HEIGHT) * item.scale;
      if (item.position[1] + height > waterTop - SURFACE_MARGIN) {
        throw new Error(
          `Plant "${item.assetId}" at y ${item.position[1]} reaches ${(item.position[1] + height).toFixed(3)} m, above the water line ${(waterTop - SURFACE_MARGIN).toFixed(3)} m; lower its scale`,
        );
      }
      const half = Math.max(entry.bounds?.max[0] ?? 0.05, entry.bounds?.max[2] ?? 0.05);
      if (height >= MIN_COLLIDER_PLANT_HEIGHT) {
        colliders.push(
          plantCapsule(
            item.position[0],
            item.position[1],
            item.position[2],
            height,
            half * item.scale * 0.5,
          ),
        );
      }
    }

    const anchors: SceneAnchor[] = [];
    anemoneItems.forEach((item, i) => {
      const entry = catalog.get(item.assetId);
      checkClearOfGlass(entry, item, preset.current ?? DEFAULT_CURRENT, extent);
      colliders.push(anemoneCollider(entry, item));
      anchors.push(anemoneAnchor(`anemone-${i + 1}`, entry, item));
    });

    const current = preset.current ?? DEFAULT_CURRENT;
    for (const [i, entry] of euphylliaItems.entries()) {
      const fullDetail = generateEuphyllia(entry.variant, entry.seed, 2);
      euphylliaItems[i] = { ...entry, fullDetail };
      checkEuphylliaClearOfGlass(entry.item, fullDetail.bounds, current, extent);
      colliders.push(euphylliaCollider(fullDetail.bounds, entry.item));
    }

    const scene = new TankScene(
      engine,
      library,
      preset,
      colliders,
      hardColliderCount,
      plantEntries,
      hardItems,
      anemoneItems,
      euphylliaItems,
      anchors,
      options,
    );
    scene.current.configure(preset.current ?? DEFAULT_CURRENT);
    scene.releases.push(engine.onFrame((deltaS) => scene.current.advance(deltaS)));
    scene.releases.push(
      engine.onFrame(() => {
        scene.fluorescence.value = fluorescenceLevel(engine.interior.actinicExcitation);
      }),
    );
    const key = keyFor(tier, settings);
    await scene.rebuildVisuals(key, () => false);
    scene.queue.adopt(key);
    scene.releases.push(applyBiomeLighting(engine, preset.biome));
    scene.releases.push(engine.quality.register('scene', (s, t) => scene.applyTier(t, s)));
    return scene;
  }

  get biome(): Biome {
    return this.preset.biome;
  }

  /** The preset's movable pieces, which an unedited tank shows. */
  get presetHardDecor(): readonly DecorItem[] {
    return this.presetHard;
  }

  /** Plants, anemones and procedural corals from the preset, which stay where they are. */
  get fixedDecor(): readonly DecorItem[] {
    return fixedDecorOf(this.preset.decor, this.library.catalog);
  }

  catalogEntries(): IterableIterator<CatalogEntry> {
    return this.library.catalog.entries();
  }

  /**
   * Swaps the rocks, wood and ornaments for `items` at the installed quality tier and refits their
   * colliders, so the collider field and the `?colliders=1` overlay follow the moved pieces. The
   * sim gets the moved pieces' colliders from the decor layer instead.
   */
  async setHardDecor(items: readonly DecorItem[]): Promise<void> {
    await this.queue.settled();
    const key = this.installedKey;
    if (this.disposed || !key) return;
    const catalog = this.library.catalog;
    const next = items.map((item) => ({ item, kind: catalog.get(item.assetId).kind }));
    for (const { item, kind } of next) {
      if (!HARDSCAPE_KINDS.has(kind)) {
        throw new Error(
          `Decor "${item.assetId}" is a ${kind}, which cannot be placed as hardscape`,
        );
      }
    }
    const hardscape = new Hardscape(this.preset.biome, this.coralGlowNode);
    const hardColliders: Collider[] = [];
    for (const { item, kind } of next) {
      const entry = catalog.get(item.assetId);
      const model = await this.library.load(item.assetId, key.hardscapeLod, key.textureSize);
      hardscape.add(entry, model, item);
      hardColliders.push(
        ...fitCollider(kind, await this.library.collisionGeometry(item.assetId), item),
      );
    }
    if (this.disposed) {
      hardscape.dispose();
      return;
    }
    this.hardscape?.dispose();
    this.hardscape = hardscape;
    this.hardItems = next;
    this.replaceHardColliders(hardColliders);
    this.engine.scene.add(hardscape.group);
    await this.evictUnused();
  }

  /** Moves one piece's meshes now; used while dragging, before the layout is committed. */
  moveHardDecor(index: number, item: DecorItem): void {
    this.hardscape?.setItem(index, item);
  }

  get colliderList(): readonly Collider[] {
    return this.colliderData;
  }

  get colliders(): ColliderField {
    return this.colliderField;
  }

  private replaceHardColliders(hard: readonly Collider[]): void {
    this.colliderData = [...hard, ...this.colliderData.slice(this.hardColliderCount)];
    this.hardColliderCount = hard.length;
    this.colliderField = new ColliderField(this.colliderData);
    this.overlay.setColliders(this.colliderData);
  }

  /** Where species with a home (clownfish and their anemone) are drawn to. */
  get anchors(): readonly SceneAnchor[] {
    return this.anchorData;
  }

  get plantCount(): number {
    return this.plantGroups.reduce((n, g) => n + g.visible, 0);
  }

  get plantCapacity(): number {
    return this.plantGroups.reduce((n, g) => n + g.total, 0);
  }

  groundHeight(x: number, z: number): number {
    return substrateHeight(this.engine.tank.dimensions, x, z);
  }

  /** Resolves when any quality-triggered rebuild has finished. */
  async settled(): Promise<void> {
    await this.queue.settled();
  }

  private applyTier(tier: Tier, settings: Readonly<TierSettings>): void {
    if (this.disposed) return;
    for (const group of this.plantGroups) group.setDensity(settings.plantDensity);
    this.queue.request(keyFor(tier, settings));
  }

  private async loadSubstrate(textureSize: 1024 | 2048): Promise<SubstrateInstall | null> {
    const spec = this.preset.substrate;
    if (!spec) return null;
    const textures: Texture[] = [];
    const anisotropy = Math.min(8, this.engine.renderer.getMaxAnisotropy());
    const load = async (assetId: string, role: string): Promise<Texture> => {
      const texture = await this.library.loadTexture(assetId, role, textureSize, anisotropy);
      textures.push(texture);
      return texture;
    };
    const loadSet = async (assetId: string): Promise<SubstrateLayers['base']> => ({
      baseColor: await load(assetId, 'baseColor'),
      normal: await load(assetId, 'normal'),
      arm: await load(assetId, 'occlusionRoughnessMetal'),
    });
    try {
      const layers: SubstrateLayers = {
        base: await loadSet(spec.assetId),
        accent: spec.accentAssetId ? await loadSet(spec.accentAssetId) : null,
      };
      const material = createSubstrateMaterial(layers, spec, this.engine.tank.dimensions);
      return { material, textures, textureSize };
    } catch (error) {
      for (const texture of textures) this.library.releaseTexture(texture);
      throw error;
    }
  }

  private discardSubstrate(install: SubstrateInstall): void {
    install.material.dispose();
    for (const texture of install.textures) this.library.releaseTexture(texture);
  }

  /**
   * Builds the models for `key` and installs them unless a newer tier was requested meanwhile
   * (`generation` is stale) or the scene was disposed; a dropped build frees what it made.
   */
  private async rebuildVisuals(key: VisualKey, isStale: () => boolean): Promise<boolean> {
    const hardscape = new Hardscape(this.preset.biome, this.coralGlowNode);
    const groups: PlantGroup[] = [];
    const anemones: AnemoneGroup[] = [];
    const euphyllias: EuphylliaGroup[] = [];
    let substrate: SubstrateInstall | null = null;
    try {
      if (!this.substrate || this.substrate.textureSize !== key.textureSize) {
        substrate = await this.loadSubstrate(key.textureSize);
      }
      for (const { item } of this.hardItems) {
        const entry = this.library.catalog.get(item.assetId);
        const model = await this.library.load(item.assetId, key.hardscapeLod, key.textureSize);
        hardscape.add(entry, model, item);
      }
      for (const [assetId, entries] of this.plantEntries) {
        const model = await this.library.load(assetId, key.plantLod, key.textureSize);
        groups.push(new PlantGroup(assetId, model, entries, this.current));
      }
      for (const item of this.anemoneItems) {
        const entry = this.library.catalog.get(item.assetId);
        const model = await this.library.load(item.assetId, key.hardscapeLod, key.textureSize);
        anemones.push(new AnemoneGroup(entry, model, item, this.current));
      }
      for (const { item, variant, seed, fullDetail } of this.euphylliaItems) {
        const mesh =
          key.euphylliaDetail === 2 && fullDetail
            ? fullDetail
            : generateEuphyllia(variant, seed, key.euphylliaDetail);
        euphyllias.push(new EuphylliaGroup(mesh, item, this.current));
      }
    } catch (error) {
      hardscape.dispose();
      for (const group of groups) group.dispose();
      for (const anemone of anemones) anemone.dispose();
      for (const coral of euphyllias) coral.dispose();
      if (substrate) this.discardSubstrate(substrate);
      throw error;
    }
    if (this.disposed || isStale()) {
      hardscape.dispose();
      for (const group of groups) group.dispose();
      for (const anemone of anemones) anemone.dispose();
      for (const coral of euphyllias) coral.dispose();
      if (substrate) this.discardSubstrate(substrate);
      await this.evictUnused();
      return false;
    }
    this.hardscape?.dispose();
    for (const group of this.plantGroups) group.dispose();
    for (const anemone of this.anemones) anemone.dispose();
    for (const coral of this.euphyllias) coral.dispose();
    this.hardscape = hardscape;
    this.plantGroups = groups;
    this.anemones = anemones;
    this.euphyllias = euphyllias;
    this.engine.scene.add(hardscape.group);
    for (const anemone of anemones) this.engine.scene.add(anemone.object);
    for (const coral of euphyllias) this.engine.scene.add(coral.object);
    for (const group of groups) {
      group.setDensity(this.engine.quality.settings.plantDensity);
      this.engine.scene.add(group.object);
    }
    if (substrate) {
      const previous = this.substrate;
      this.engine.tank.substrate.material = substrate.material;
      this.substrate = substrate;
      if (previous) this.discardSubstrate(previous);
    }
    this.installedKey = key;
    await this.evictUnused();
    return true;
  }

  private async evictUnused(): Promise<void> {
    const key = this.installedKey;
    const keep = new Set<string>();
    if (key) {
      for (const { item } of this.hardItems) {
        keep.add(this.library.modelKey(item.assetId, key.hardscapeLod, key.textureSize));
      }
      for (const item of this.anemoneItems) {
        keep.add(this.library.modelKey(item.assetId, key.hardscapeLod, key.textureSize));
      }
      for (const assetId of this.plantEntries.keys()) {
        keep.add(this.library.modelKey(assetId, key.plantLod, key.textureSize));
      }
    }
    await this.library.retainOnly(keep);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const release of this.releases) release();
    this.releases.length = 0;
    await this.queue.stop();
    this.hardscape?.dispose();
    for (const group of this.plantGroups) group.dispose();
    for (const anemone of this.anemones) anemone.dispose();
    for (const coral of this.euphyllias) coral.dispose();
    this.overlay.dispose();
    if (this.substrate) {
      this.engine.tank.substrate.material = this.placeholderSubstrate;
      this.discardSubstrate(this.substrate);
      this.substrate = null;
    }
    await this.library.dispose();
  }
}

export function glassExtent(dimensions: {
  readonly length: number;
  readonly depth: number;
  readonly glass: number;
}): Extent {
  return {
    halfLength: dimensions.length / 2 - dimensions.glass - WALL_MARGIN,
    halfDepth: dimensions.depth / 2 - dimensions.glass - WALL_MARGIN,
  };
}

export function checkClearOfGlass(
  entry: CatalogEntry,
  item: DecorItem,
  current: CurrentParameters,
  extent: Extent,
): void {
  const reach = anemoneReach(entry, item, current);
  if (
    Math.abs(item.position[0]) + reach > extent.halfLength ||
    Math.abs(item.position[2]) + reach > extent.halfDepth
  ) {
    throw new Error(
      `Anemone "${item.assetId}" at ${item.position[0]}, ${item.position[2]} reaches ${reach.toFixed(3)} m and would cross the glass; move it inwards`,
    );
  }
}

export function fixedDecorOf(
  decor: readonly DecorItem[],
  catalog: Pick<AssetCatalog, 'get'>,
): DecorItem[] {
  return decor.filter(
    (i) =>
      parseEuphylliaId(i.assetId) !== null || !HARDSCAPE_KINDS.has(catalog.get(i.assetId).kind),
  );
}

export function checkEuphylliaClearOfGlass(
  item: DecorItem,
  bounds: EuphylliaMesh['bounds'],
  current: CurrentParameters,
  extent: Extent,
): void {
  const reach = euphylliaReach(bounds, item, current);
  if (
    Math.abs(item.position[0]) + reach > extent.halfLength ||
    Math.abs(item.position[2]) + reach > extent.halfDepth
  ) {
    throw new Error(
      `Coral "${item.assetId}" at ${item.position[0]}, ${item.position[2]} reaches ${reach.toFixed(3)} m and would cross the glass; move it inwards`,
    );
  }
}

export function plantReach(
  assetId: string,
  bounds: { readonly min: readonly number[]; readonly max: readonly number[] } | undefined,
  current: CurrentParameters,
): (scale: number) => number {
  const height = bounds
    ? Math.max(Math.abs(bounds.min[1] ?? 0), bounds.max[1] ?? 0)
    : FALLBACK_PLANT_HEIGHT;
  const half = bounds
    ? Math.hypot(
        Math.max(Math.abs(bounds.min[0] ?? 0), Math.abs(bounds.max[0] ?? 0)),
        Math.max(Math.abs(bounds.min[2] ?? 0), Math.abs(bounds.max[2] ?? 0)),
      )
    : 0.1;
  // Euler YXZ tilts both axes at once: tip offset is h*sqrt(sin²Z + sin²X cos²Z), max when both equal T.
  const lean = Math.sin(MAX_PLANT_TILT) * Math.sqrt(1 + Math.cos(MAX_PLANT_TILT) ** 2) * height;
  const sway = maxSway(assetId, height, current);
  return (scale) => (half + lean) * scale + sway;
}

function plantCapsule(
  x: number,
  y: number,
  z: number,
  height: number,
  radius: number,
): CapsuleCollider {
  const r = Math.max(0.04, radius);
  return {
    kind: 'capsule',
    hard: false,
    a: [x, y + r, z],
    b: [x, y + Math.max(r, height * 0.8), z],
    radius: r,
  };
}

function softPatchCollider(
  patch: PlantPatch,
  instances: readonly { x: number; y: number; z: number; scale: number }[],
  assetHeight: number | undefined,
): CapsuleCollider | null {
  if (instances.length === 0 || assetHeight === undefined) return null;
  const meanScale = (patch.scale[0] + patch.scale[1]) / 2;
  const height = assetHeight * meanScale;
  if (height < MIN_COLLIDER_PLANT_HEIGHT) return null;
  const n = instances.length;
  const x = instances.reduce((s, p) => s + p.x, 0) / n;
  const y = instances.reduce((s, p) => s + p.y, 0) / n;
  const z = instances.reduce((s, p) => s + p.z, 0) / n;
  return plantCapsule(x, y, z, height, patch.radius * 0.7);
}
