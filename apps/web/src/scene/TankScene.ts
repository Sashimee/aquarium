import type { Ray } from 'three';
import type { Material, MeshStandardNodeMaterial, Texture } from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
  legacyTintSeed,
  type Biome,
  type DecorItem,
  type Plant,
  type PlantPatch,
  type PresetLayout,
} from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import type { TankDimensions } from '../engine/tank/dimensions';
import type { Tier, TierSettings } from '../engine/quality/tiers';
import { substrateHeight } from '../engine/tank/substrate';
import { abortError } from './abortable';
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
import type { FlowField } from '@aquarium/sim';
import { CurrentField, reachCurrent, type CurrentParameters } from './current';
import { fluorescenceLevel } from './coralStyle';
import { PolypSignal } from './polyps';
import {
  createCoralGlowNode,
  fitCollider,
  Hardscape,
  HARDSCAPE_KINDS,
  PLANT_KIND,
} from './hardscape';
import { boundsFromCatalog, fitPresetToTank } from './presetFit';
import { applyBiomeLighting } from './lighting';
import type { SceneOptions } from './options';
import { ColliderOverlay } from './overlay';
import {
  MAX_TILT_RAD as MAX_PLANT_TILT,
  scatterPatch,
  type ReachFn,
  type Extent,
  type PlantInstance,
} from './placement';
import { RebuildQueue } from './rebuildQueue';
import {
  PlantGroup,
  maxSway,
  surfaceScaleCeiling,
  SURFACE_MARGIN,
  type PlantEntry,
} from './plants';
import {
  grownItem,
  offsetEntries,
  pickablePlants,
  pickPlant,
  type GrowthContext,
  type LayoutPlantRef,
  type PlantPick,
} from './plantGrowth';
import { layoutPlantKeys } from '@aquarium/sim/lifecycle';
import { createSubstrateMaterial, type SubstrateLayers } from './substrate';

const FALLBACK_PLANT_HEIGHT = 0.2;
const MIN_OFFSET_CAPACITY = 16;

export function offsetCapacity(count: number): number {
  return Math.max(MIN_OFFSET_CAPACITY, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
}

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

interface BuiltPlants {
  readonly groups: PlantGroup[];
  readonly created: PlantGroup[];
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

  /**
   * Sways plants, corals and anemones with the sim's pump. `World` lives in the sim worker, so
   * the caller builds the `FlowField` (null without a pump) with `new FlowField(bounds, settings)`
   * from `@aquarium/sim`. `bounds` must match the sim's `World.flowBounds()`, which is private to
   * the worker; take the same minX/maxX/minZ/maxZ/minY/maxY from `Basin.fromTank(tank)` or
   * `Basin.fromSpace(space)` built from the config the worker was given.
   * Call `syncWaveMaker` every frame with the snapshot's `time`.
   */
  setWaveMaker(field: FlowField | null, simTimeS: number): void {
    this.current.setWaveMaker(field, simTimeS);
  }

  syncWaveMaker(simTimeS: number): void {
    this.current.syncWaveMaker(simTimeS);
  }

  /** Coral polyp extension; call `polyps.bind(simClient)` for the active tank's sim. */
  readonly polyps = new PolypSignal();
  private readonly fluorescence = uniform(0);
  private readonly coralGlowNode = createCoralGlowNode(this.fluorescence);
  private hardscape: Hardscape | null = null;
  private anemones: AnemoneGroup[] = [];
  private euphyllias: EuphylliaGroup[] = [];
  private plantGroups: PlantGroup[] = [];
  private offsetGroups = new Map<string, PlantGroup>();
  private plantState: ReadonlyMap<string, Plant> = new Map();
  private installedKey: VisualKey | null = null;
  private readonly queue: RebuildQueue<VisualKey>;
  private substrate: SubstrateInstall | null = null;
  private readonly placeholderSubstrate: Material | Material[];
  private disposed = false;
  private readonly presetMovable: readonly { item: DecorItem; kind: string }[];
  private movablePlants = false;
  private plantSlots = new Map<number, number>();
  private layoutVersion = 0;
  private readonly releases: (() => void)[] = [];

  private constructor(
    private readonly engine: Engine,
    private readonly library: ModelLibrary,
    private readonly preset: PresetLayout,
    private colliderData: readonly Collider[],
    /** The leading entries of `colliderData`, fitted to the movable hardscape and layout plants. */
    private movableColliderCount: number,
    plantSlots: ReadonlyMap<number, number>,
    private readonly patchEntries: ReadonlyMap<string, PlantEntry[]>,
    private hardItems: readonly { item: DecorItem; kind: string }[],
    private readonly anemoneItems: readonly DecorItem[],
    private readonly euphylliaItems: readonly EuphylliaItem[],
    private readonly anchorData: readonly SceneAnchor[],
    options: SceneOptions,
  ) {
    this.presetMovable = hardItems;
    this.plantSlots = new Map(plantSlots);
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
    signal?: AbortSignal,
  ): Promise<TankScene> {
    const catalog = await AssetCatalog.fetch(undefined, signal);
    signal?.throwIfAborted();
    const library = new ModelLibrary(engine.ktx2, catalog);
    let sceneOwnsLibrary = false;
    let scene: TankScene;
    try {
      scene = await TankScene.build(engine, library, catalog, preset, options, signal, () => {
        sceneOwnsLibrary = true;
      });
    } catch (error) {
      if (!sceneOwnsLibrary) await library.dispose();
      throw error;
    }
    if (signal?.aborted) {
      try {
        await scene.dispose();
      } catch (cause) {
        engine.events.emit('engine:error', {
          message: 'Could not clean up an abandoned preset build',
          cause,
        });
      }
      throw abortError(signal);
    }
    return scene;
  }

  private static async build(
    engine: Engine,
    library: ModelLibrary,
    catalog: AssetCatalog,
    authored: PresetLayout,
    options: SceneOptions,
    signal: AbortSignal | undefined,
    adopted: () => void,
  ): Promise<TankScene> {
    const settings = engine.quality.settings;
    const tier = engine.quality.tier;
    const dimensions = engine.tank.dimensions;
    const preset = fitPresetToCatalog(authored, dimensions, catalog);

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
      else if (kind === PLANT_KIND) layoutPlants.push(item);
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

    const waterTop = dimensions.height - dimensions.freeboard;
    hardItems.push(...layoutPlants.map((item) => ({ item, kind: PLANT_KIND })));
    const movable = await movableColliders(library, hardItems, waterTop);
    signal?.throwIfAborted();
    const colliders: Collider[] = [...movable.colliders];
    const movableColliderCount = colliders.length;
    const hard = new ColliderField(colliders);
    const extent = glassExtent(dimensions);

    const patchEntries = new Map<string, PlantEntry[]>();
    const entriesFor = (assetId: string) => {
      let list = patchEntries.get(assetId);
      if (!list) patchEntries.set(assetId, (list = []));
      return list;
    };

    colliders.push(
      ...scatterPresetPatches(preset, catalog, hard, dimensions, (patch, instances) => {
        const list = entriesFor(patch.assetId);
        instances.forEach((instance, i) =>
          list.push({ ...instance, rank: i / Math.max(1, instances.length) }),
        );
      }),
    );
    const anchors: SceneAnchor[] = [];
    anemoneItems.forEach((item, i) => {
      const entry = catalog.get(item.assetId);
      checkClearOfGlass(
        entry,
        item,
        reachCurrent(preset.current ?? DEFAULT_CURRENT, preset.biome),
        extent,
      );
      colliders.push(anemoneCollider(entry, item));
      anchors.push(anemoneAnchor(`anemone-${i + 1}`, entry, item));
    });

    const current = reachCurrent(preset.current ?? DEFAULT_CURRENT, preset.biome);
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
      movableColliderCount,
      movable.plantSlots,
      patchEntries,
      hardItems,
      anemoneItems,
      euphylliaItems,
      anchors,
      options,
    );
    adopted();
    try {
      scene.current.configure(preset.current ?? DEFAULT_CURRENT);
      scene.releases.push(engine.onFrame((deltaS) => scene.current.advance(deltaS)));
      scene.releases.push(
        engine.onFrame(() => {
          scene.fluorescence.value = fluorescenceLevel(engine.interior.actinicExcitation);
        }),
      );
      const key = keyFor(tier, settings);
      await scene.rebuildVisuals(key, () => signal?.aborted ?? false);
      signal?.throwIfAborted();
      scene.queue.adopt(key);
      scene.releases.push(applyBiomeLighting(engine, preset.biome));
      scene.releases.push(engine.quality.register('scene', (s, t) => scene.applyTier(t, s)));
    } catch (error) {
      await scene.dispose();
      throw error;
    }
    return scene;
  }

  get biome(): Biome {
    return this.preset.biome;
  }

  /** The preset's movable pieces, which an unedited tank shows. */
  get presetHardDecor(): readonly DecorItem[] {
    return this.presetMovable
      .filter(({ kind }) => this.movablePlants || kind !== PLANT_KIND)
      .map(({ item }) => item);
  }

  /** Anemones, procedural corals and, until `enableMovablePlants`, plants: what stays where it is. */
  get fixedDecor(): readonly DecorItem[] {
    return fixedDecorOf(this.preset.decor, this.library.catalog, this.movablePlants);
  }

  /**
   * Makes plants movable pieces: `presetHardDecor` then lists the preset's layout plants,
   * `fixedDecor` drops them, and `setHardDecor`/`moveHardDecor` take plant items next to rocks and
   * wood. Call before the decor layer reads the scene. Plants are opt-in so a decor layer that has
   * no plant pieces keeps seeing them as fixed.
   */
  enableMovablePlants(): void {
    this.movablePlants = true;
  }

  catalogEntries(): IterableIterator<CatalogEntry> {
    return this.library.catalog.entries();
  }

  /**
   * Swaps the rocks, wood and ornaments (and plants, once movable) for `items` at the installed
   * quality tier and refits their colliders, so the collider field and the `?colliders=1` overlay
   * follow the moved pieces. The sim gets the moved pieces' colliders from the decor layer instead.
   */
  async setHardDecor(items: readonly DecorItem[]): Promise<void> {
    const catalog = this.library.catalog;
    const given = items.map((item) => ({ item, kind: catalog.get(item.assetId).kind }));
    for (const { item, kind } of given) {
      if (!HARDSCAPE_KINDS.has(kind) && !(this.movablePlants && kind === PLANT_KIND)) {
        throw new Error(
          `Decor "${item.assetId}" is a ${kind}, which cannot be placed as ${this.movablePlants ? 'movable decor' : 'hardscape'}`,
        );
      }
    }
    const fixedPlants = this.movablePlants
      ? []
      : this.presetMovable.filter(({ kind }) => kind === PLANT_KIND);
    const next = [...given, ...fixedPlants];
    const dimensions = this.engine.tank.dimensions;
    const waterTop = dimensions.height - dimensions.freeboard;
    for (;;) {
      await this.queue.settled();
      const key = this.installedKey;
      if (this.disposed || !key) return;
      const hardscape = new Hardscape(this.preset.biome, this.coralGlowNode, this.polyps.node);
      let built: BuiltPlants = { groups: [], created: [] };
      try {
        for (const { item, kind } of next) {
          if (kind === PLANT_KIND) continue;
          const model = await this.library.load(item.assetId, key.hardscapeLod, key.textureSize);
          hardscape.add(catalog.get(item.assetId), model, item);
        }
        built = await this.buildPlantGroups(key, next, this.plantGroups);
        const movable = await movableColliders(this.library, next, waterTop);
        if (this.disposed || this.installedKey !== key) {
          hardscape.dispose();
          for (const group of built.created) group.dispose();
          if (this.disposed) return;
          continue;
        }
        this.hardscape?.dispose();
        for (const group of this.plantGroups) {
          if (!built.groups.includes(group)) group.dispose();
        }
        this.hardscape = hardscape;
        this.plantGroups = built.groups;
        this.hardItems = next;
        this.layoutVersion++;
        this.plantSlots = new Map(movable.plantSlots);
        this.replaceMovableColliders(movable.colliders);
      } catch (error) {
        hardscape.dispose();
        for (const group of built.created) group.dispose();
        throw error;
      }
      this.engine.scene.add(hardscape.group);
      for (const group of built.created) {
        group.setDensity(this.engine.quality.settings.plantDensity);
        this.engine.scene.add(group.object);
      }
      this.syncGrowth();
      await this.evictUnused();
      return;
    }
  }

  /**
   * Shows the growth state: layout plants at their grown size, offsets as extra instances at their
   * positions. Moves instances in place; nothing is rebuilt unless an asset gets more offsets
   * than its group has room for. Absent or empty `plants` is the layout as drawn.
   */
  setPlants(plants: readonly Plant[] | undefined): void {
    this.plantState = new Map((plants ?? []).map((p) => [p.key, p]));
    this.syncGrowth();
  }

  /** The plant whose stem `ray` (tank space) passes closest to, with the key and size to trim. */
  pickPlant(ray: Ray): PlantPick | null {
    const refs = this.plantRefs(this.hardItems).map(({ ref }) => ref);
    return pickPlant(ray, pickablePlants(refs, this.growthContext()));
  }

  private growthContext(): GrowthContext {
    return {
      plants: this.plantState,
      ground: (x, z) => this.groundHeight(x, z),
      waterTop: this.waterTop,
    };
  }

  private plantRefs(
    items: readonly { item: DecorItem; kind: string }[],
  ): { index: number; ref: LayoutPlantRef }[] {
    const plants: { index: number; item: DecorItem }[] = [];
    items.forEach(({ item, kind }, index) => {
      if (kind === PLANT_KIND) plants.push({ index, item });
    });
    const growing = new Set<string>();
    for (const plant of this.plantState.values()) growing.add(plant.assetId);
    const growers = plants.filter(({ item }) => growing.has(item.assetId));
    const keys = new Map(
      layoutPlantKeys(
        growers.map(({ item }) => ({
          assetId: item.assetId,
          position: item.position,
          tintSeed: item.tintSeed ?? legacyTintSeed(item),
        })),
      ).map((key, i) => [growers[i]?.index, key]),
    );
    return plants.map(({ index, item }) => {
      const bounds = this.library.catalog.get(item.assetId).bounds;
      return {
        index,
        ref: {
          key: keys.get(index) ?? `unkeyed:${index}`,
          item,
          height: bounds?.max[1] ?? FALLBACK_PLANT_HEIGHT,
          halfWidth: Math.max(bounds?.max[0] ?? 0.05, bounds?.max[2] ?? 0.05),
        },
      };
    });
  }

  private grownLayoutItem(index: number, item: DecorItem): DecorItem {
    const found = this.plantRefs(
      this.hardItems.map((h, i) => (i === index ? { ...h, item } : h)),
    ).find((r) => r.index === index);
    return found ? grownItem(found.ref, this.growthContext()) : item;
  }

  private syncGrowth(): void {
    if (this.disposed) return;
    const context = this.growthContext();
    const refs = this.plantRefs(this.hardItems);
    let collidersChanged = false;
    for (const { index, ref } of refs) {
      const target = locateMovable(this.hardItems, index);
      if (target?.kind !== 'plant') continue;
      const group = this.plantGroups.find((g) => g.assetId === target.assetId);
      const grown = grownItem(ref, context);
      const next = layoutPlantEntry(grown);
      if (group && group.entryAt(target.ordinal)?.scale !== next.scale) {
        group.setGrown(target.ordinal, next);
      }
      const colliderIndex = this.plantSlots.get(index);
      if (colliderIndex === undefined) continue;
      const collider = layoutPlantCollider(this.library.catalog.get(ref.item.assetId), grown);
      if (
        collider &&
        JSON.stringify(this.colliderData[colliderIndex]) !== JSON.stringify(collider)
      ) {
        this.colliderData = this.colliderData.map((c, i) => (i === colliderIndex ? collider : c));
        collidersChanged = true;
      }
    }
    if (collidersChanged) {
      this.colliderField = new ColliderField(this.colliderData);
      this.overlay.setColliders(this.colliderData);
    }
    this.syncOffsets(
      offsetEntries(
        refs.map(({ ref }) => ref),
        context,
      ),
    );
  }

  private syncOffsets(entries: ReadonlyMap<string, readonly PlantEntry[]>): void {
    const density = this.engine.quality.settings.plantDensity;
    for (const assetId of new Set([...entries.keys(), ...this.offsetGroups.keys()])) {
      const list = entries.get(assetId) ?? [];
      const host = this.plantGroups.find((g) => g.assetId === assetId);
      const existing = this.offsetGroups.get(assetId);
      if (existing && host && existing.model === host.model && existing.setLive(list)) continue;
      existing?.dispose();
      this.offsetGroups.delete(assetId);
      if (!host || list.length === 0) continue;
      const group = new PlantGroup(
        assetId,
        host.model,
        list,
        this.current,
        offsetCapacity(list.length),
      );
      group.setDensity(density);
      this.offsetGroups.set(assetId, group);
      this.engine.scene.add(group.object);
    }
  }

  /** Moves one piece now; used while dragging, before the layout is committed. */
  moveHardDecor(index: number, item: DecorItem): void {
    const target = locateMovable(this.hardItems, index);
    if (!target) return;
    this.hardItems = this.hardItems.map((h, i) => (i === index ? { item, kind: h.kind } : h));
    if (target.kind === 'hardscape') {
      this.hardscape?.setItem(target.index, item);
      return;
    }
    const group = this.plantGroups.find((g) => g.assetId === target.assetId);
    const grown = this.grownLayoutItem(index, item);
    group?.setEntry(target.ordinal, layoutPlantEntry(grown));
    const colliderIndex = this.plantSlots.get(index);
    if (colliderIndex === undefined) return;
    const moved = layoutPlantCollider(this.library.catalog.get(item.assetId), grown);
    if (!moved) return;
    this.colliderData = this.colliderData.map((c, i) => (i === colliderIndex ? moved : c));
    this.colliderField = new ColliderField(this.colliderData);
    this.overlay.setColliders(this.colliderData);
  }

  /**
   * What the sim reads at mount. Once plants are movable the decor layer reports their capsules
   * with the other placed pieces, so they are left out here to keep fish from meeting them twice.
   */
  get colliderList(): readonly Collider[] {
    if (!this.movablePlants) return this.colliderData;
    const plantColliders = new Set(this.plantSlots.values());
    return this.colliderData.filter((_, i) => !plantColliders.has(i));
  }

  get colliders(): ColliderField {
    return this.colliderField;
  }

  private replaceMovableColliders(movable: readonly Collider[]): void {
    this.colliderData = [...movable, ...this.colliderData.slice(this.movableColliderCount)];
    this.movableColliderCount = movable.length;
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

  get waterTop(): number {
    const { height, freeboard } = this.engine.tank.dimensions;
    return height - freeboard;
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

  /** Groups whose layout plants are unchanged are taken from `reuse`; only the others are built. */
  private async buildPlantGroups(
    key: VisualKey,
    movable: readonly { item: DecorItem; kind: string }[],
    reuse: readonly PlantGroup[] = [],
  ): Promise<BuiltPlants> {
    const layout = new Map<string, PlantEntry[]>();
    const context = this.growthContext();
    for (const { ref } of this.plantRefs(movable)) {
      const list = layout.get(ref.item.assetId) ?? [];
      list.push(layoutPlantEntry(grownItem(ref, context)));
      layout.set(ref.item.assetId, list);
    }
    const assetIds = new Set([...layout.keys(), ...this.patchEntries.keys()]);
    const groups: PlantGroup[] = [];
    const created: PlantGroup[] = [];
    try {
      for (const assetId of assetIds) {
        const own = layout.get(assetId) ?? [];
        const sig = JSON.stringify(own);
        const kept = reuse.find((g) => g.assetId === assetId);
        if (kept?.layoutSignature === sig) {
          groups.push(kept);
          continue;
        }
        const model = await this.library.load(assetId, key.plantLod, key.textureSize);
        const group = new PlantGroup(
          assetId,
          model,
          [...own, ...(this.patchEntries.get(assetId) ?? [])],
          this.current,
        );
        groups.push(group);
        created.push(group);
      }
    } catch (error) {
      for (const group of created) group.dispose();
      throw error;
    }
    return { groups, created };
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
    for (;;) {
      const done = await this.rebuildOnce(key, isStale, this.layoutVersion, this.hardItems);
      if (done !== 'layout-changed') return done;
    }
  }

  /**
   * One pass over a snapshot of the movable items. A `setHardDecor` that lands while it builds
   * changes the layout under it, so the result is dropped for a retry instead of mixing layouts.
   */
  private async rebuildOnce(
    key: VisualKey,
    isStale: () => boolean,
    version: number,
    items: readonly { item: DecorItem; kind: string }[],
  ): Promise<boolean | 'layout-changed'> {
    const hardscape = new Hardscape(this.preset.biome, this.coralGlowNode, this.polyps.node);
    let built: BuiltPlants = { groups: [], created: [] };
    const anemones: AnemoneGroup[] = [];
    const euphyllias: EuphylliaGroup[] = [];
    let substrate: SubstrateInstall | null = null;
    try {
      if (!this.substrate || this.substrate.textureSize !== key.textureSize) {
        substrate = await this.loadSubstrate(key.textureSize);
      }
      for (const { item, kind } of items) {
        if (kind === PLANT_KIND) continue;
        const entry = this.library.catalog.get(item.assetId);
        const model = await this.library.load(item.assetId, key.hardscapeLod, key.textureSize);
        hardscape.add(entry, model, item);
      }
      built = await this.buildPlantGroups(key, items);
      for (const item of this.anemoneItems) {
        const entry = this.library.catalog.get(item.assetId);
        const model = await this.library.load(item.assetId, key.hardscapeLod, key.textureSize);
        anemones.push(new AnemoneGroup(entry, model, item, this.current, this.polyps.node));
      }
      for (const { item, variant, seed, fullDetail } of this.euphylliaItems) {
        const mesh =
          key.euphylliaDetail === 2 && fullDetail
            ? fullDetail
            : generateEuphyllia(variant, seed, key.euphylliaDetail);
        euphyllias.push(new EuphylliaGroup(mesh, item, this.current, this.polyps.node));
      }
    } catch (error) {
      hardscape.dispose();
      for (const group of built.groups) group.dispose();
      for (const anemone of anemones) anemone.dispose();
      for (const coral of euphyllias) coral.dispose();
      if (substrate) this.discardSubstrate(substrate);
      throw error;
    }
    const outdated = this.layoutVersion !== version;
    if (this.disposed || isStale() || outdated) {
      hardscape.dispose();
      for (const group of built.groups) group.dispose();
      for (const anemone of anemones) anemone.dispose();
      for (const coral of euphyllias) coral.dispose();
      if (substrate) this.discardSubstrate(substrate);
      if (this.disposed || isStale()) {
        await this.evictUnused();
        return false;
      }
      return 'layout-changed';
    }
    this.hardscape?.dispose();
    for (const group of this.plantGroups) group.dispose();
    for (const anemone of this.anemones) anemone.dispose();
    for (const coral of this.euphyllias) coral.dispose();
    this.hardscape = hardscape;
    this.plantGroups = built.groups;
    this.anemones = anemones;
    this.euphyllias = euphyllias;
    this.engine.scene.add(hardscape.group);
    for (const anemone of anemones) this.engine.scene.add(anemone.object);
    for (const coral of euphyllias) this.engine.scene.add(coral.object);
    for (const group of built.groups) {
      group.setDensity(this.engine.quality.settings.plantDensity);
      this.engine.scene.add(group.object);
    }
    this.syncGrowth();
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
      for (const { item, kind } of this.hardItems) {
        const lod = kind === PLANT_KIND ? key.plantLod : key.hardscapeLod;
        keep.add(this.library.modelKey(item.assetId, lod, key.textureSize));
      }
      for (const item of this.anemoneItems) {
        keep.add(this.library.modelKey(item.assetId, key.hardscapeLod, key.textureSize));
      }
      for (const assetId of this.patchEntries.keys()) {
        keep.add(this.library.modelKey(assetId, key.plantLod, key.textureSize));
      }
    }
    await this.library.retainOnly(keep);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const release of this.releases) release();
    this.releases.length = 0;
    this.polyps.dispose();
    await this.queue.stop();
    this.hardscape?.dispose();
    for (const group of this.plantGroups) group.dispose();
    for (const group of this.offsetGroups.values()) group.dispose();
    this.offsetGroups.clear();
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

export function fitPresetToCatalog(
  preset: PresetLayout,
  dimensions: TankDimensions,
  catalog: Pick<AssetCatalog, 'get'>,
): PresetLayout {
  const current = reachCurrent(preset.current ?? DEFAULT_CURRENT, preset.biome);
  return fitPresetToTank(preset, dimensions, boundsFromCatalog(catalog, current), (patch, axis) =>
    plantReach(patch.assetId, catalog.get(patch.assetId).bounds, current)(patch.scale[1], axis),
  );
}

export function scatterPresetPatches(
  preset: PresetLayout,
  catalog: Pick<AssetCatalog, 'get'>,
  hard: ColliderField,
  dimensions: TankDimensions,
  onPatch: (patch: PlantPatch, instances: PlantInstance[]) => void,
): CapsuleCollider[] {
  const waterTop = dimensions.height - dimensions.freeboard;
  const extent = glassExtent(dimensions);
  const ground = (x: number, z: number) => substrateHeight(dimensions, x, z);
  const normal = new Float64Array(3);
  const blocked = (x: number, y: number, z: number) =>
    hard.hard(x, y + 0.02, z, normal) < BLOCKED_CLEARANCE;
  const soft: CapsuleCollider[] = [];
  for (const patch of preset.plantPatches) {
    const bounds = catalog.get(patch.assetId).bounds;
    const reach = plantReach(
      patch.assetId,
      bounds,
      reachCurrent(preset.current ?? DEFAULT_CURRENT, preset.biome),
    );
    const ceiling = surfaceScaleCeiling(waterTop, bounds?.max[1] ?? FALLBACK_PLANT_HEIGHT);
    const instances = scatterPatch(patch, ground, blocked, extent, reach, ceiling);
    if (instances.length < patch.count) {
      console.warn(
        `Plant patch "${patch.id}" fitted ${instances.length} of ${patch.count} plants; move it clear of hardscape and glass`,
      );
    }
    onPatch(patch, instances);
    const collider = softPatchCollider(patch, instances, bounds?.max[1]);
    if (collider) soft.push(collider);
  }
  return soft;
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
  plantsMovable = false,
): DecorItem[] {
  return decor.filter((i) => {
    if (parseEuphylliaId(i.assetId) !== null) return true;
    const kind = catalog.get(i.assetId).kind;
    return !HARDSCAPE_KINDS.has(kind) && !(plantsMovable && kind === PLANT_KIND);
  });
}

export async function movableColliders(
  library: Pick<ModelLibrary, 'catalog' | 'collisionGeometry'>,
  movable: readonly { item: DecorItem; kind: string }[],
  waterTop: number,
): Promise<{ colliders: Collider[]; plantSlots: Map<number, number> }> {
  const colliders: Collider[] = [];
  const plantSlots = new Map<number, number>();
  for (const [i, { item, kind }] of movable.entries()) {
    if (kind === PLANT_KIND) {
      const entry = library.catalog.get(item.assetId);
      checkBelowSurface(entry, item, waterTop);
      const capsule = layoutPlantCollider(entry, item);
      if (capsule) {
        plantSlots.set(i, colliders.length);
        colliders.push(capsule);
      }
    } else {
      colliders.push(...fitCollider(kind, await library.collisionGeometry(item.assetId), item));
    }
  }
  return { colliders, plantSlots };
}

export type MovableTarget =
  | { readonly kind: 'hardscape'; readonly index: number }
  | { readonly kind: 'plant'; readonly assetId: string; readonly ordinal: number };

/** Where movable item `index` lives: its Hardscape slot, or its instance among its species' layout plants. */
export function locateMovable(
  movable: readonly { item: DecorItem; kind: string }[],
  index: number,
): MovableTarget | null {
  const slot = movable[index];
  if (!slot) return null;
  const before = movable.slice(0, index);
  if (slot.kind !== PLANT_KIND) {
    return { kind: 'hardscape', index: before.filter((h) => h.kind !== PLANT_KIND).length };
  }
  const assetId = slot.item.assetId;
  return {
    kind: 'plant',
    assetId,
    ordinal: before.filter((h) => h.kind === PLANT_KIND && h.item.assetId === assetId).length,
  };
}

export function layoutPlantEntry(item: DecorItem): PlantEntry {
  return {
    x: item.position[0],
    y: item.position[1],
    z: item.position[2],
    yaw: item.rotationY,
    tiltX: 0,
    tiltZ: 0,
    scale: item.scale,
    tone: 1,
    rank: -1,
  };
}

export function checkBelowSurface(entry: CatalogEntry, item: DecorItem, waterTop: number): void {
  const height = (entry.bounds?.max[1] ?? FALLBACK_PLANT_HEIGHT) * item.scale;
  if (item.position[1] + height > waterTop - SURFACE_MARGIN) {
    throw new Error(
      `Plant "${item.assetId}" at y ${item.position[1]} reaches ${(item.position[1] + height).toFixed(3)} m, above the water line ${(waterTop - SURFACE_MARGIN).toFixed(3)} m; lower its scale`,
    );
  }
}

export function layoutPlantCollider(entry: CatalogEntry, item: DecorItem): CapsuleCollider | null {
  const height = (entry.bounds?.max[1] ?? FALLBACK_PLANT_HEIGHT) * item.scale;
  if (height < MIN_COLLIDER_PLANT_HEIGHT) return null;
  const half = Math.max(entry.bounds?.max[0] ?? 0.05, entry.bounds?.max[2] ?? 0.05);
  return plantCapsule(
    item.position[0],
    item.position[1],
    item.position[2],
    height,
    half * item.scale * 0.5,
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
): ReachFn {
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
  const sway = {
    x: maxSway(assetId, height, current, 'x'),
    z: maxSway(assetId, height, current, 'z'),
  };
  const swayAny = maxSway(assetId, height, current);
  return (scale, axis) => (half + lean) * scale + (axis ? sway[axis] : swayAny);
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
