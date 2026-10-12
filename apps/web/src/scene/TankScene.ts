import type { DecorItem, PlantPatch, PresetLayout } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import type { Tier, TierSettings } from '../engine/quality/tiers';
import { substrateHeight } from '../engine/tank/substrate';
import { AssetCatalog, ModelLibrary, type ModelLod } from './assets';
import { ColliderField, type CapsuleCollider, type Collider } from './colliders';
import { CurrentField, type CurrentParameters } from './current';
import { fitCollider, Hardscape, HARDSCAPE_KINDS } from './hardscape';
import type { SceneOptions } from './options';
import { ColliderOverlay } from './overlay';
import { scatterPatch, type Extent } from './placement';
import { PlantGroup, type PlantEntry } from './plants';
import { createSubstrateMaterial, type SubstrateLayers } from './substrate';

const DEFAULT_CURRENT: CurrentParameters = {
  direction: [1, 0],
  speed: 0.04,
  gustPeriodS: 9,
  gustDepth: 0.4,
};

const PLANT_LOD: Readonly<Record<Tier, ModelLod>> = { low: 2, medium: 1, high: 1, ultra: 0 };
const HARDSCAPE_LOD: Readonly<Record<Tier, ModelLod>> = { low: 2, medium: 1, high: 0, ultra: 0 };
const WALL_MARGIN = 0.03;
const BLOCKED_CLEARANCE = 0.03;
const MIN_COLLIDER_PLANT_HEIGHT = 0.15;

interface VisualKey {
  readonly plantLod: ModelLod;
  readonly hardscapeLod: ModelLod;
  readonly textureSize: 1024 | 2048;
}

function keyFor(tier: Tier, settings: Readonly<TierSettings>): VisualKey {
  return {
    plantLod: PLANT_LOD[tier],
    hardscapeLod: HARDSCAPE_LOD[tier],
    textureSize: settings.textureSize,
  };
}

function sameKey(a: VisualKey, b: VisualKey): boolean {
  return (
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
  readonly colliders: ColliderField;

  private hardscape: Hardscape | null = null;
  private plantGroups: PlantGroup[] = [];
  private visualKey: VisualKey | null = null;
  private rebuilding: Promise<void> | null = null;
  private pendingSettings: { tier: Tier; settings: Readonly<TierSettings> } | null = null;
  private disposed = false;
  private readonly releases: (() => void)[] = [];

  private constructor(
    private readonly engine: Engine,
    private readonly library: ModelLibrary,
    private readonly preset: PresetLayout,
    private readonly colliderData: readonly Collider[],
    private readonly plantEntries: ReadonlyMap<string, PlantEntry[]>,
    private readonly hardItems: readonly { item: DecorItem; kind: string }[],
    options: SceneOptions,
  ) {
    this.colliders = new ColliderField(colliderData);
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
    const library = new ModelLibrary(engine.renderer, catalog);
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
    const textureSize = settings.textureSize;
    const dimensions = engine.tank.dimensions;

    const hardItems: { item: DecorItem; kind: string }[] = [];
    const layoutPlants: DecorItem[] = [];
    for (const item of preset.decor) {
      const kind = catalog.get(item.assetId).kind;
      if (HARDSCAPE_KINDS.has(kind)) hardItems.push({ item, kind });
      else if (kind === 'plant') layoutPlants.push(item);
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
      const geometries = await library.collisionGeometry(item.assetId, textureSize);
      colliders.push(...fitCollider(kind, geometries, item));
    }
    const hard = new ColliderField(colliders);

    const { length, depth, glass } = dimensions;
    const extent: Extent = {
      halfLength: length / 2 - glass - WALL_MARGIN,
      halfDepth: depth / 2 - glass - WALL_MARGIN,
    };
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
      const instances = scatterPatch(patch, ground, blocked, extent);
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
      const height = (entry.bounds?.max[1] ?? 0) * item.scale;
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

    const scene = new TankScene(
      engine,
      library,
      preset,
      colliders,
      plantEntries,
      hardItems,
      options,
    );
    scene.current.configure(preset.current ?? DEFAULT_CURRENT);
    scene.releases.push(engine.onFrame((deltaS) => scene.current.advance(deltaS)));
    await scene.applySubstrate(textureSize);
    await scene.rebuildVisuals(keyFor(tier, settings), settings.plantDensity);
    scene.releases.push(engine.quality.register('scene', (s, t) => scene.applyTier(t, s)));
    return scene;
  }

  get colliderList(): readonly Collider[] {
    return this.colliderData;
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
    while (this.rebuilding) await this.rebuilding;
  }

  private applyTier(tier: Tier, settings: Readonly<TierSettings>): void {
    if (this.disposed) return;
    for (const group of this.plantGroups) group.setDensity(settings.plantDensity);
    const key = keyFor(tier, settings);
    if (this.visualKey && sameKey(this.visualKey, key)) return;
    this.pendingSettings = { tier, settings };
    if (this.rebuilding) return;
    this.rebuilding = this.drainRebuilds().finally(() => {
      this.rebuilding = null;
    });
  }

  private async drainRebuilds(): Promise<void> {
    while (this.pendingSettings && !this.disposed) {
      const { tier, settings } = this.pendingSettings;
      this.pendingSettings = null;
      const key = keyFor(tier, settings);
      if (this.visualKey && sameKey(this.visualKey, key)) continue;
      try {
        await this.rebuildVisuals(key, settings.plantDensity);
      } catch (cause) {
        this.engine.events.emit('engine:error', {
          message: 'Could not switch scene models to the new quality tier',
          cause,
        });
      }
    }
  }

  private async applySubstrate(textureSize: 1024 | 2048): Promise<void> {
    const spec = this.preset.substrate;
    if (!spec) return;
    const anisotropy = Math.min(8, this.engine.renderer.getMaxAnisotropy());
    const load = async (assetId: string): Promise<SubstrateLayers['base']> => ({
      baseColor: await this.library.loadTexture(assetId, 'baseColor', textureSize, anisotropy),
      normal: await this.library.loadTexture(assetId, 'normal', textureSize, anisotropy),
      arm: await this.library.loadTexture(
        assetId,
        'occlusionRoughnessMetal',
        textureSize,
        anisotropy,
      ),
    });
    const layers: SubstrateLayers = {
      base: await load(spec.assetId),
      accent: spec.accentAssetId ? await load(spec.accentAssetId) : null,
    };
    if (this.disposed) return;
    this.engine.tank.substrate.material = createSubstrateMaterial(
      layers,
      spec,
      this.engine.tank.dimensions,
    );
  }

  private async rebuildVisuals(key: VisualKey, density: number): Promise<void> {
    const hardscape = new Hardscape();
    for (const { item } of this.hardItems) {
      const entry = this.library.catalog.get(item.assetId);
      const model = await this.library.load(item.assetId, key.hardscapeLod, key.textureSize);
      hardscape.add(entry, model, item);
    }
    const groups: PlantGroup[] = [];
    for (const [assetId, entries] of this.plantEntries) {
      const model = await this.library.load(assetId, key.plantLod, key.textureSize);
      groups.push(new PlantGroup(assetId, model, entries, this.current));
    }
    if (this.disposed) {
      hardscape.dispose();
      for (const group of groups) group.dispose();
      return;
    }
    this.hardscape?.dispose();
    for (const group of this.plantGroups) group.dispose();
    this.hardscape = hardscape;
    this.plantGroups = groups;
    this.engine.scene.add(hardscape.group);
    for (const group of groups) {
      group.setDensity(density);
      this.engine.scene.add(group.object);
    }
    this.visualKey = key;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const release of this.releases) release();
    this.releases.length = 0;
    await this.rebuilding;
    this.hardscape?.dispose();
    for (const group of this.plantGroups) group.dispose();
    this.overlay.dispose();
    const material = this.engine.tank.substrate.material;
    if (!Array.isArray(material) && material.name === 'substrate-textured') material.dispose();
    await this.library.dispose();
  }
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
