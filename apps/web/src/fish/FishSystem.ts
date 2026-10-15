import { sampleFloor, type Biome, type Collider } from '@aquarium/shared';
import {
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type InstancedBufferAttribute,
} from 'three/webgpu';
import {
  CARCASS,
  carcassFate,
  carcassSettleS,
  CarcassSupport,
  quatFromYawPitchRoll,
  Rng,
  SimClient,
  sinkingCarcass,
  SnapshotField,
  STEP_DT,
  type FishPlacement,
  type Point3,
  type SpeciesInput,
  type Stimulus,
  type TankSpaceWorldConfig,
} from '@aquarium/sim';
import type { Engine } from '../engine/Engine';
import type { EventBus } from '../engine/events';
import { releaseAll } from '../engine/lifecycle';
import type { Tier, TierSettings } from '../engine/quality/tiers';
import { waterBounds, type TankDimensions } from '../engine/tank/dimensions';
import type { InteractionEvents } from '../interaction/events';
import type { FishAssetEntry, ShrimpRig } from './assetIndex';
import { disposeFishModel, FishAssetLoader, type FishModel } from './assets';
import { AcclimationBags } from './bag';
import { BatchCache } from './batchCache';
import type { SceneAnchor } from '../scene/anemone';
import { demoTank, type DemoTank } from './demoStock';
import { HeldFish, type FramePresence } from './heldFish';
import {
  FishInstanceData,
  INSTANCE_STRIDE,
  WALKER_INSTANCE_STRIDE,
  type InstanceValues,
  type WalkerValues,
} from './instances';
import { selectLod, type LodThresholds } from './lod';
import { featuresFor, sameFeatures, waitsForReload } from './features';
import { FishMaterial, type FishMaterialFeatures } from './material';
import { commitLodDraw } from './prewarm';
import {
  bagCentre,
  bagHeight,
  bagPose,
  bagRadius,
  createPose,
  deadAnchor,
  deadPose,
  dyingPose,
  raySphere,
  type Anchor,
  type WaterBox,
} from './poses';
import {
  batchKeyOf,
  bodyLengthOf,
  modelFor,
  renderProfile,
  swimModeFor,
  type FishRenderProfile,
} from './profiles';
import { hashString, TankRoster, type RosterFish } from './roster';
import { SimStream } from './simStream';
import {
  initSim,
  layoutChanges,
  SimErrorGate,
  SimInitTimeout,
  SimWorldSpec,
  startWorld,
} from './simWorld';
import { SimUnavailableError } from '../interaction/simUnavailable';
import { speciesInput } from './species';
import type { FishBite, FishPoint, PickRay, TankEvent } from './start';
import { isFinned, SWIM_MODES, SwimState, type SwimModeParams, type SwimmingMode } from './swim';
import { curlAboveFloor, WalkState, type WalkSample } from './walk';

export interface FishSystemOptions {
  readonly tank: TankDimensions;
  /** Folder holding `index.json` and the fish GLBs, with a trailing slash. */
  readonly assetRoot: string;
  /** The demo stock shown while no saved tank is loaded. */
  readonly biome: Biome;
  readonly interaction: EventBus<InteractionEvents>;
  readonly seed?: number;
  readonly signal: AbortSignal;
}

interface LodBatch {
  readonly instances: FishInstanceData;
  readonly matrices: InstancedBufferAttribute;
  readonly meshes: readonly InstancedMesh[];
  readonly materials: readonly FishMaterial[];
  count: number;
  warmed: boolean;
}

interface SpeciesBatch {
  readonly input: SpeciesInput;
  /** Replaced, with its LODs, when the tier's texture size changes. */
  model: FishModel;
  readonly profile: FishRenderProfile;
  lods: readonly LodBatch[];
  capacity: number;
  /** What its materials draw with; behind `FishSystem.features` while a texture reload is due. */
  features: FishMaterialFeatures | null;
}

/** Fish rise and float belly-up; shrimp are denser than water and sink. */
type Script =
  | {
      readonly kind: 'dying' | 'dead';
      readonly startS: number;
      readonly anchor: Anchor;
    }
  | {
      readonly kind: 'sinking';
      readonly startS: number;
      readonly anchor: Anchor;
      /** What it lands on: the substrate or the top of hard decor. */
      readonly floorY: number;
      /** How it was drawn when it died, eased out of while it goes limp; null if it never was. */
      readonly fromQuaternion: Quaternion | null;
    };

interface FishRuntime {
  readonly fish: RosterFish;
  readonly batch: SpeciesBatch;
  readonly length: number;
  readonly scale: number;
  readonly motion: SwimState | WalkState;
  readonly seed: number;
  readonly tint: readonly [number, number, number];
  readonly filmThickness: number;
  readonly condition: number;
  lod: number;
  /** Drawn last frame, at `lastPosition`/`lastQuaternion`. */
  shown: boolean;
  readonly lastPosition: Vector3;
  readonly lastQuaternion: Quaternion;
  /** Seconds left of the blend from `fromPosition` (its bag) into the sim's pose. */
  handover: number;
  readonly fromPosition: Vector3;
  readonly fromQuaternion: Quaternion;
  bagSlot: number | null;
  script: Script | null;
}

/** LOD levels near enough for their self-shadowing to read. */
const SHADOW_LODS = 2;
/** A fish leaving its bag, or held over a rebuilt world, glides into the sim's pose this long. */
const HANDOVER_S = 1.2;
/** Below this horizontal share of its forward axis a body is climbing and has no heading. */
const CLIMBING_FORWARD_XZ = 0.5;
/** Fingertip slop when netting a small fish, in metres. */
const MIN_PICK_RADIUS = 0.02;
const MIN_CAPACITY = 4;
/** How much a sick fish (health 0) pales; death pales it fully. */
const SICK_PALING = 0.7;

function capacityFor(needed: number): number {
  let capacity = MIN_CAPACITY;
  while (capacity < needed) capacity *= 2;
  return capacity;
}

export type BatchLocomotion =
  | { readonly kind: 'swim'; readonly mode: SwimModeParams }
  | { readonly kind: 'walk'; readonly shrimp: ShrimpRig };

export function batchLocomotion(
  entry: FishAssetEntry,
  swimmingMode: SwimmingMode,
  profile: FishRenderProfile,
): BatchLocomotion {
  if (isFinned(swimmingMode)) {
    return { kind: 'swim', mode: swimModeFor(SWIM_MODES[swimmingMode], profile) };
  }
  if (entry.shrimp === null) {
    throw new Error(`fish ${entry.id}: a walking species needs a shrimp model`);
  }
  return { kind: 'walk', shrimp: entry.shrimp };
}

function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Far above a cold worker start on a slow phone; past it the worker is taken to be stuck. */
const SIM_INIT_TIMEOUT_MS = 15_000;

function spawnSimWorker(): Worker {
  return new Worker(new URL('./simWorker.ts', import.meta.url), {
    type: 'module',
    name: 'fish-sim',
  });
}

/**
 * Streams the 30 Hz sim from its worker, interpolates it at render rate, and draws every fish as
 * instanced, kinematically deformed meshes. The renderer never steps behaviour itself: swimming
 * fish come from the sim, while bagged, dying and dead ones follow the fixed poses in `poses.ts`.
 *
 * Which fish exist is the `TankRoster`'s job: the demo stock, or a saved tank driven by the
 * `tank:*` events. A fish joining or leaving the swimming set is added to or removed from the
 * running sim world, so the others carry on; only swapping the tank or demo stock builds a new one.
 */
export class FishSystem {
  readonly group = new Group();
  private readonly roster: TankRoster;
  private readonly runtimes = new Map<string, FishRuntime>();
  private readonly batches = new BatchCache<SpeciesBatch>(
    (batch) => {
      this.disposeLods(batch);
      disposeFishModel(batch.model);
    },
    () => this.wantedBatches(),
  );
  private readonly stream = new SimStream(STEP_DT, (snapshot) => this.sim.recycle(snapshot));
  private readonly held = new HeldFish();
  private support = new CarcassSupport([]);
  private readonly loader: FishAssetLoader;
  private readonly bags: AcclimationBags;
  private readonly lifetime = new AbortController();
  private readonly box: WaterBox;
  private readonly spec: SimWorldSpec;
  private readonly cleanups: (() => void)[] = [];
  private readonly ateListeners = new Set<(events: readonly FishBite[]) => void>();
  /** `asset@size` loads that failed; the batch keeps the model it has and is not retried. */
  private readonly failedRetextures = new Set<string>();
  /** Replaced, with its worker, when the worker stops answering. */
  private sim: SimClient;
  /** The fish in the running world once the commands sent so far land; null with no world. */
  private inWorld: Set<string> | null = null;
  /** Bumped whenever the world is dropped, so add/remove replies from before are ignored. */
  private generation = 0;
  private sceneRevision = -1;
  private simReady = false;
  private dirty = false;
  private syncing = false;
  private readonly syncWaiters: (() => void)[] = [];
  private clockS = 0;
  private thresholds: LodThresholds = { midDistance: 1, impostorDistance: 3 };
  private shadows: Readonly<TierSettings> | null = null;
  private features: FishMaterialFeatures | null = null;
  private night = 0;
  private light = 1;
  private disposed = false;
  /** False while `create` runs: a failure then fails `create`, which disposes the worker anyway. */
  private started = false;
  private readonly simErrors = new SimErrorGate((message) => this.report(`Fish sim: ${message}`));

  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3();
  private readonly forward = new Vector3();
  private readonly quat = new Float32Array(4);
  private readonly pose = createPose();
  private readonly walkSample: WalkSample = {
    speed: 0,
    state: -1,
    legPhase: 0,
    flip: 0,
    attached: 1,
  };
  private readonly walker: WalkerValues = {
    legPhase: 0,
    stride: 0,
    curl: 0,
    paddle: 0,
    pick: 0,
    dance: 0,
  };
  private readonly values: InstanceValues = {
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    scale: 1,
    phase: 0,
    amplitude: 0,
    curvature: 0,
    finPhase: 0,
    pale: 0,
    seed: 0,
    filmThickness: 0,
    tint: [1, 1, 1],
    gills: 0,
  };

  /**
   * Rejects with `signal.reason` once `signal` aborts, after releasing whatever was already loaded,
   * so a page torn down mid-load never builds onto a disposed engine.
   */
  static async create(engine: Engine, options: FishSystemOptions): Promise<FishSystem> {
    const { signal } = options;
    signal.throwIfAborted();
    const seed = options.seed ?? Math.floor(Math.random() * 0x7fffffff);
    const demo = demoTank(options.tank, seed, options.biome);
    const system = new FishSystem(engine, spawnSimWorker(), options, demo, seed);
    const onAbort = (): void => system.release();
    signal.addEventListener('abort', onAbort);
    system.cleanups.push(() => signal.removeEventListener('abort', onAbort));
    try {
      await system.loadSpecies();
      signal.throwIfAborted();
      system.materialize();
      await system.syncWorld();
      signal.throwIfAborted();
    } catch (cause) {
      // Before release, which silences `report`; an aborted start is meant to go quietly.
      if (!signal.aborted) system.simErrors.close(cause);
      system.release();
      throw signal.aborted ? signal.reason : cause;
    }
    system.started = true;
    system.simErrors.open();
    if (system.staleTextures().length > 0) system.requestSync();
    return system;
  }

  private constructor(
    private readonly engine: Engine,
    private worker: Worker,
    private readonly options: FishSystemOptions,
    demo: DemoTank,
    private readonly seed: number,
  ) {
    const bounds = waterBounds(options.tank);
    const space = demo.config.space;
    this.box = {
      minX: bounds.min.x,
      maxX: bounds.max.x,
      ground: (x, z) => sampleFloor(space, x, z),
      minZ: bounds.min.z,
      maxZ: bounds.max.z,
      top: bounds.max.y,
    };
    this.roster = new TankRoster(demo.config.fish);
    this.spec = new SimWorldSpec(demo, seed);
    this.loader = new FishAssetLoader(engine.ktx2, options.assetRoot);
    this.group.name = 'fish';
    this.bags = new AcclimationBags(this.group);
    engine.scene.add(this.group);
    this.cleanups.push(
      () => this.group.removeFromParent(),
      () => {
        this.sim.dispose();
        this.worker.terminate();
      },
      () => this.bags.dispose(),
      () => this.batches.dispose(),
      () => this.runtimes.clear(),
    );
    this.sim = this.connectSim(worker);
    this.cleanups.push(
      engine.quality.register('fish-lod', (s) => {
        this.thresholds = s.fishLod;
      }),
      engine.quality.register('fish-shadows', (s) => {
        this.shadows = s;
        for (const batch of this.batches.values()) this.applyShadows(batch);
      }),
      // Ahead of the materials, which skip the batches this marks stale: their retexture rebuilds
      // them with the new tier's features anyway.
      engine.quality.register('fish-textures', (s) => {
        if (this.loader.textureSize === s.textureSize) return;
        this.loader.textureSize = s.textureSize;
        if (this.started && !this.disposed) this.requestSync();
      }),
      engine.quality.register('fish-materials', (_s, tier) =>
        this.applyFeatures(tier, new Set(this.staleTextures())),
      ),
      engine.onFrame((deltaS, nowMs) => this.update(deltaS, nowMs)),
      engine.events.on('engine:daylight', ({ level }) => this.setDaylight(level)),
      engine.events.on('engine:temporal-resolve', () => this.applyFeatures(engine.quality.tier)),
    );
    this.setDaylight(engine.daylight);
  }

  /** Applies a saved-tank event; see `InteractionEvents` for the contract. */
  handle(event: TankEvent): void {
    if (this.disposed) return;
    let swapped = false;
    switch (event.type) {
      case 'tank:loaded':
        this.roster.load(event.payload);
        this.stopWorld();
        swapped = true;
        break;
      case 'tank:unloaded':
        swapped = this.roster.unload(event.payload);
        if (swapped) this.stopWorld();
        break;
      case 'tank:none':
        swapped = this.roster.none();
        if (swapped) this.stopWorld();
        break;
      case 'tank:fish-added':
        this.roster.add(event.payload);
        break;
      case 'tank:fish-released':
        this.roster.release(event.payload);
        break;
      case 'tank:fish-died': {
        const fish = this.roster.died(event.payload);
        if (fish !== null) this.startDeath(fish);
        break;
      }
      case 'tank:fish-updated':
        this.roster.updated(event.payload);
        break;
      case 'tank:fish-removed':
        this.roster.removed(event.payload);
        break;
    }
    this.prune();
    if (swapped) this.batches.evictUnwanted();
    this.materialize();
    this.requestSync();
  }

  /** Replaces the demo stock with `biome`'s; a loaded saved tank is left alone. */
  setDemoBiome(biome: Biome): void {
    if (this.disposed) return;
    const demo = demoTank(this.options.tank, this.seed, biome);
    const swapped = this.roster.setDemo(demo.config.fish);
    if (swapped) this.stopWorld();
    this.prune();
    // After `prune`, so no runtime still points at an evicted batch.
    if (swapped) this.batches.evictUnwanted();
    this.materialize();
    this.requestSync();
  }

  /** The id the rest of the app uses for a sim fish: its server id while a saved tank is shown. */
  serverIdOf(simId: string): string | undefined {
    return this.roster.serverIdOf(simId);
  }

  simIdOf(serverId: string): string | undefined {
    return this.roster.simIdOf(serverId);
  }

  /** `stimulus.position` is in tank space, which the sim and the scene share. */
  startle(stimulus: Stimulus): void {
    if (!this.disposed && this.simReady) this.sim.startle(stimulus);
  }

  /** A laser dot or fingertip in tank space, or null once it is gone. */
  setLure(position: Point3 | null): void {
    if (!this.disposed && this.simReady) this.sim.setLure(position);
  }

  /**
   * Homes from the scene: the clownfish's anemone. Kept for every later sim world, since a
   * re-initialised world starts with only the anchors in its config.
   */
  setAnchors(anchors: readonly SceneAnchor[]): void {
    if (this.disposed) return;
    const simAnchors = this.spec.setAnchors(anchors);
    if (this.simReady) this.sim.setAnchors(simAnchors);
  }

  /**
   * Every collider the sim avoids, in the shared format; kept for later worlds like anchors. Dead
   * shrimp land on the hard ones.
   */
  setColliders(colliders: readonly Collider[]): void {
    if (this.disposed) return;
    this.spec.setDecor(colliders);
    if (this.simReady) this.sim.setDecor(colliders);
    this.support = new CarcassSupport(colliders);
    this.resettleCarcasses();
  }

  setFood(buffer: Float32Array): void {
    if (!this.disposed && this.simReady) this.sim.setFood(buffer);
  }

  /** Bites by the ids the app knows: server fish ids while a saved tank is shown. */
  onAte(listener: (events: readonly FishBite[]) => void): () => void {
    this.ateListeners.add(listener);
    return () => this.ateListeners.delete(listener);
  }

  /** The nearest dead fish along `ray` that the server knows, or null. */
  pickDead(ray: PickRay): string | null {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const rt of this.runtimes.values()) {
      const { serverId, phase } = rt.fish;
      if (phase !== 'dead' || serverId === null || !rt.shown) continue;
      const radius = Math.max(rt.length / 2, MIN_PICK_RADIUS);
      const hit = raySphere(ray.origin, ray.dir, rt.lastPosition, radius);
      if (hit !== null && hit < bestDistance) {
        bestDistance = hit;
        best = serverId;
      }
    }
    return best;
  }

  /** The nearest swimming fish along `ray`, as a position the camera can follow, or null. */
  pickFish(ray: PickRay): (() => FishPoint | null) | null {
    let best: FishRuntime | null = null;
    let bestDistance = Infinity;
    for (const rt of this.runtimes.values()) {
      if (rt.fish.phase !== 'swimming' || !rt.shown) continue;
      const radius = Math.max(rt.length / 2, MIN_PICK_RADIUS);
      const hit = raySphere(ray.origin, ray.dir, rt.lastPosition, radius);
      if (hit !== null && hit < bestDistance) {
        bestDistance = hit;
        best = rt;
      }
    }
    return best === null ? null : this.follow(best);
  }

  swimmingSpecies(): readonly string[] {
    return this.roster.swimmingSpecies();
  }

  /** The species in the tank that eat nori, for the clip placement check. */
  noriGrazers(): string[] {
    const species = new Set<string>();
    for (const fish of this.roster.swimming()) {
      if (speciesInput(fish.species)?.lifecycle.diet.includes('nori')) species.add(fish.species);
    }
    return [...species];
  }

  /** See `SimClient.canGrazeAt`; rejects while the sim is not up. */
  canGrazeAt(species: string, position: Point3): Promise<boolean> {
    if (this.disposed || !this.simReady) {
      return Promise.reject(new SimUnavailableError());
    }
    return this.sim.canGrazeAt(species, position).catch((cause: unknown) => {
      throw this.disposed || !this.simReady
        ? new SimUnavailableError('The fish sim went away')
        : cause;
    });
  }

  /** Some swimming fish to follow, for a control that has no pointer to pick with. */
  anyFish(): (() => FishPoint | null) | null {
    for (const rt of this.runtimes.values()) {
      if (rt.fish.phase === 'swimming' && rt.shown) return this.follow(rt);
    }
    return null;
  }

  private follow(rt: FishRuntime): () => FishPoint | null {
    return () => {
      if (this.disposed || !rt.shown || this.runtimes.get(rt.fish.simId) !== rt) return null;
      const { x, y, z } = rt.lastPosition;
      return { x, y, z };
    };
  }

  /** The net tool tapped along `ray`; the session asks for confirmation before netting. */
  netTap(ray: PickRay): void {
    const fishId = this.pickDead(ray);
    if (fishId !== null) this.options.interaction.emit('net:tap', { fishId });
  }

  /** Fish pale at night by their species' sensitivity, and the sim lets them rest. */
  private setDaylight(level: number): void {
    this.light = level;
    this.night = 1 - level;
    if (!this.disposed && this.simReady) this.sim.setLight(level);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort(new Error('fish system disposed'));
    this.ateListeners.clear();
    for (const resolve of this.syncWaiters.splice(0)) resolve();
    releaseAll(this.cleanups.splice(0), 'FishSystem');
  }

  /** Disposes where no caller could catch it, so a failed cleanup is reported, not thrown. */
  private release(): void {
    try {
      this.dispose();
    } catch (cause) {
      this.engine.events.emit('engine:error', { message: 'Fish cleanup failed', cause });
    }
  }

  /** Silent once the engine is going: its teardown fails loads that are still in flight. */
  private report(message: string, cause?: unknown): void {
    if (this.disposed || this.engine.disposed) return;
    this.engine.events.emit('engine:error', cause === undefined ? { message } : { message, cause });
  }

  private requestSync(): void {
    this.dirty = true;
    if (this.syncing) return;
    this.syncing = true;
    void this.runSync().finally(() => {
      this.syncing = false;
      for (const resolve of this.syncWaiters.splice(0)) resolve();
    });
  }

  /** Resolves once the stock handed in so far has loaded and joined the sim, or failed to. */
  synced(): Promise<void> {
    if (!this.syncing || this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.syncWaiters.push(resolve));
  }

  /** One pass at a time, so sim inits never overlap; changes made meanwhile run another pass. */
  private async runSync(): Promise<void> {
    while (this.dirty && !this.disposed) {
      this.dirty = false;
      try {
        await this.loadSpecies();
        await this.retexture();
        if (this.disposed) return;
        this.materialize();
        await this.syncWorld();
      } catch (cause) {
        if (this.disposed) return;
        this.held.releaseAll();
        this.report('Fish could not be updated for the new tank stock', cause);
      } finally {
        // A pending pass reloads what this one left stale, and catches up after itself.
        if (!this.disposed && !this.dirty) this.catchUpFeatures();
      }
    }
  }

  /**
   * Loads every model the roster draws with; one that fails stays unseen.
   * Batches are keyed by species and model, so a guppy male and female draw from separate
   * batches but stay one sim species.
   */
  private async loadSpecies(): Promise<void> {
    const wanted = new Map<string, RosterFish>();
    for (const fish of this.roster.entries()) {
      const key = batchKeyOf(fish);
      if (!wanted.has(key)) wanted.set(key, fish);
    }
    await Promise.all(
      [...wanted].map(([key, fish]) => this.batches.load(key, () => this.createBatch(fish))),
    );
  }

  private async createBatch(fish: RosterFish): Promise<SpeciesBatch | null> {
    const { species } = fish;
    const input = speciesInput(species);
    if (input === undefined) {
      this.report(`Fish species "${species}" has no content in this build; it stays hidden`);
      return null;
    }
    let model: FishModel;
    let profile: FishRenderProfile;
    try {
      profile = renderProfile(species);
      model = await this.loader.load(modelFor(profile, fish).assetId);
    } catch (cause) {
      this.report(`Fish "${species}" has no visual; it swims and eats unseen`, cause);
      return null;
    }
    return { input, model, profile, lods: [], capacity: 0, features: null };
  }

  /** Grows a species' instance buffers; the materials are rebuilt around the new ones. */
  private ensureCapacity(batch: SpeciesBatch, needed: number): void {
    if (needed <= batch.capacity) return;
    this.disposeLods(batch);
    const capacity = capacityFor(needed);
    const { model, profile, input } = batch;
    const locomotion = batchLocomotion(model.entry, input.locomotion.swimmingMode, profile);
    const lighting = {
      lightDirection: this.engine.caustics.lightDirection,
      light: this.engine.caustics.hoodLight(),
    };
    batch.lods = model.lods.map((parts, level) => {
      const walking = locomotion.kind === 'walk';
      const instances = new FishInstanceData(
        capacity,
        walking ? WALKER_INSTANCE_STRIDE : INSTANCE_STRIDE,
      );
      const meshes: InstancedMesh[] = [];
      const materials: FishMaterial[] = [];
      for (const part of parts) {
        const material = new FishMaterial({
          source: part.source,
          assetId: model.entry.id,
          profile,
          locomotion:
            locomotion.kind === 'walk'
              ? {
                  kind: 'walk',
                  rig: {
                    bodyLength: model.entry.standardLengthM,
                    hinge: locomotion.shrimp.hinge,
                    telsonZ: locomotion.shrimp.telsonZ,
                    legPivots: part.legPivots,
                  },
                }
              : locomotion,
          zMin: model.entry.min[2],
          zMax: model.entry.max[2],
          instances,
          lighting,
        });
        if (this.features !== null) material.setFeatures(this.features);
        const mesh = new InstancedMesh(part.geometry, material, capacity);
        const first = meshes[0];
        if (first !== undefined) mesh.instanceMatrix = first.instanceMatrix;
        mesh.name = `${model.entry.id}:lod${level}`;
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        mesh.count = 0;
        mesh.visible = false;
        meshes.push(mesh);
        materials.push(material);
        this.group.add(mesh);
      }
      const matrices = meshes[0]?.instanceMatrix;
      if (matrices === undefined) throw new Error(`fish ${model.entry.id}: lod${level} is empty`);
      matrices.setUsage(DynamicDrawUsage);
      return { instances, matrices, meshes, materials, count: 0, warmed: false };
    });
    batch.capacity = capacity;
    batch.features = this.features;
    this.applyShadows(batch);
  }

  /** Keeps the model: only the instanced meshes and their materials go. */
  private disposeLods(batch: SpeciesBatch): void {
    for (const lod of batch.lods) {
      for (const mesh of lod.meshes) {
        mesh.removeFromParent();
        mesh.dispose();
      }
      for (const material of lod.materials) material.dispose();
    }
    batch.lods = [];
    batch.capacity = 0;
  }

  private staleTextures(): SpeciesBatch[] {
    return [...this.batches.values()].filter(({ model }) => {
      const size = this.loader.textureSizeFor(model.entry);
      return size !== model.textureSize && !this.failedRetextures.has(`${model.entry.id}@${size}`);
    });
  }

  /** Reloads each batch whose maps are not the tier's size; it keeps drawing the old ones meanwhile. */
  private async retexture(): Promise<void> {
    await Promise.all(
      this.staleTextures().map(async (batch) => {
        const assetId = batch.model.entry.id;
        const size = this.loader.textureSizeFor(batch.model.entry);
        let model: FishModel;
        try {
          model = await this.loader.load(assetId);
        } catch (cause) {
          this.failedRetextures.add(`${assetId}@${size}`);
          if (this.features !== null) this.setBatchFeatures(batch, this.features);
          this.report(
            `Fish "${assetId}" ${size}px textures failed; it keeps its current ones`,
            cause,
          );
          return;
        }
        if (this.disposed || ![...this.batches.values()].includes(batch)) {
          disposeFishModel(model);
          return;
        }
        const { capacity } = batch;
        this.disposeLods(batch);
        disposeFishModel(batch.model);
        batch.model = model;
        this.ensureCapacity(batch, capacity);
      }),
    );
  }

  private wantedBatches(): Set<string> {
    const keys = new Set<string>();
    for (const fish of this.roster.entries()) keys.add(batchKeyOf(fish));
    return keys;
  }

  /** Builds a runtime for every roster fish whose model is loaded. */
  private materialize(): void {
    const perBatch = new Map<string, number>();
    for (const fish of this.roster.entries()) {
      const key = batchKeyOf(fish);
      perBatch.set(key, (perBatch.get(key) ?? 0) + 1);
    }
    for (const [key, count] of perBatch) {
      const batch = this.batches.get(key);
      if (batch !== undefined) this.ensureCapacity(batch, count);
    }
    for (const fish of this.roster.entries()) {
      if (this.runtimes.has(fish.simId)) continue;
      const batch = this.batches.get(batchKeyOf(fish));
      if (batch !== undefined) this.runtimes.set(fish.simId, this.createRuntime(fish, batch));
    }
  }

  private createRuntime(fish: RosterFish, batch: SpeciesBatch): FishRuntime {
    const rng = new Rng((this.seed ^ hashString(fish.key)) >>> 0);
    const { profile, input } = batch;
    const length = bodyLengthOf(fish, input.locomotion.bodyLengthM);
    const v = profile.tintVariation;
    const brightness = 1 + v * rng.signed();
    const [lo, hi] = profile.filmThicknessNm;
    const seed = rng.next();
    const { swimmingMode } = input.locomotion;
    const phaseOffset = rng.next() * Math.PI * 2;
    const runtime: FishRuntime = {
      fish,
      batch,
      length,
      scale: length / batch.model.entry.standardLengthM,
      motion: isFinned(swimmingMode)
        ? new SwimState(
            length,
            input.locomotion.strouhal,
            swimModeFor(SWIM_MODES[swimmingMode], profile),
            phaseOffset,
          )
        : new WalkState(length, phaseOffset),
      seed,
      tint: [
        brightness * (1 + 0.5 * v * rng.signed()),
        brightness * (1 + 0.5 * v * rng.signed()),
        brightness * (1 + 0.5 * v * rng.signed()),
      ],
      filmThickness: lo + (hi - lo) * rng.next(),
      condition: Math.min(1, Math.max(0, 1 - fish.health)) * SICK_PALING,
      lod: 0,
      shown: false,
      lastPosition: new Vector3(),
      lastQuaternion: new Quaternion(),
      handover: 0,
      fromPosition: new Vector3(),
      fromQuaternion: new Quaternion(),
      bagSlot: null,
      script: null,
    };
    if (fish.phase === 'bagged') runtime.bagSlot = this.freeBagSlot();
    if (fish.phase === 'dead') runtime.script = this.deadScript(runtime);
    return runtime;
  }

  private freeBagSlot(): number {
    const used = new Set<number>();
    for (const rt of this.runtimes.values()) if (rt.bagSlot !== null) used.add(rt.bagSlot);
    let slot = 0;
    while (used.has(slot)) slot++;
    return slot;
  }

  /** A fish on screen plays its death from where it is; one never drawn just floats. */
  private startDeath(fish: RosterFish): void {
    const rt = this.runtimes.get(fish.simId);
    if (rt === undefined) return;
    rt.bagSlot = null;
    this.held.release(fish.simId);
    rt.handover = 0;
    if (!rt.shown) {
      rt.script = this.deadScript(rt);
      return;
    }
    const anchor: Anchor = {
      x: rt.lastPosition.x,
      y: rt.lastPosition.y,
      z: rt.lastPosition.z,
      yaw: this.restingYaw(rt.lastQuaternion),
    };
    rt.script = this.sinks(rt)
      ? this.sinkingScript(rt, anchor, this.clockS, rt.lastQuaternion.clone())
      : { kind: 'dying', startS: this.clockS, anchor };
  }

  /**
   * The heading a body keeps as it goes down. A shrimp climbing the glass or a rock face points
   * up or down, which has no heading, so it lies along its side axis: parallel to the surface it
   * was on, never into it.
   */
  private restingYaw(q: Quaternion): number {
    const f = this.forward.set(0, 0, 1).applyQuaternion(q);
    if (Math.hypot(f.x, f.z) >= CLIMBING_FORWARD_XZ) return Math.atan2(f.x, f.z);
    const side = this.forward.set(1, 0, 0).applyQuaternion(q);
    return Math.atan2(side.x, side.z);
  }

  /** Raises `anchor` out of decor it starts inside, onto what it will land on. */
  private sinkingScript(
    rt: FishRuntime,
    anchor: Anchor,
    startS: number,
    fromQuaternion: Quaternion | null,
  ): Script {
    const floorY = this.support.floorY(anchor, rt.length, this.box.ground);
    const lowest = floorY + CARCASS.restBellyBodyLengths * rt.length;
    const from = anchor.y >= lowest ? anchor : { ...anchor, y: lowest };
    return { kind: 'sinking', startS, anchor: from, floorY, fromQuaternion };
  }

  /** Decor moved: a dead shrimp lands on whatever is under it now. */
  private resettleCarcasses(): void {
    for (const rt of this.runtimes.values()) {
      const { script } = rt;
      if (script?.kind !== 'sinking') continue;
      rt.script = this.sinkingScript(rt, script.anchor, script.startS, script.fromQuaternion);
    }
  }

  private sinks(rt: FishRuntime): boolean {
    return carcassFate(rt.batch.input.locomotion.swimmingMode) === 'sink';
  }

  /** A body that was dead before it was drawn: afloat at the surface, or a shrimp already down. */
  private deadScript(rt: FishRuntime): Script {
    const anchor = deadAnchor(this.box, rt.length, rt.seed);
    if (!this.sinks(rt)) return { kind: 'dead', startS: this.clockS, anchor };
    const floorY = this.support.floorY(anchor, rt.length, this.box.ground);
    const onFloor = { ...anchor, y: floorY + CARCASS.restBellyBodyLengths * rt.length };
    return {
      kind: 'sinking',
      startS: this.clockS - carcassSettleS(onFloor, rt.length, rt.seed, floorY),
      anchor: onFloor,
      floorY,
      fromQuaternion: null,
    };
  }

  /** Drops the runtimes of fish that left the roster. */
  private prune(): void {
    for (const [simId, rt] of this.runtimes) {
      if (this.roster.get(simId) === rt.fish) continue;
      this.runtimes.delete(simId);
      this.held.release(simId);
    }
  }

  /** Until the next init nothing of the current world may show, eat or be blended from. */
  private stopWorld(): void {
    this.sim.stop();
    this.inWorld = null;
    this.generation++;
    this.stream.reset();
    this.held.releaseAll();
  }

  /** Every swimming fish on screen waits where it is for the next world. */
  private holdSwimming(): void {
    const candidates = [...this.runtimes.values()].map((rt) => ({
      id: rt.fish.simId,
      shown: rt.shown,
      phase: rt.fish.phase,
      bagged: rt.bagSlot !== null,
      scripted: rt.script !== null,
    }));
    this.held.hold(candidates, this.clockS);
  }

  /** Brings the sim's fish in line with the roster's swimming set. */
  private async syncWorld(): Promise<void> {
    const config = this.spec.config(this.roster.swimming());
    if (config === null) {
      if (this.inWorld !== null) this.stopWorld();
      return;
    }
    const inWorld = this.inWorld;
    if (inWorld === null) {
      await this.reinit(config);
      return;
    }
    const generation = this.generation;
    const { remove, add } = layoutChanges(inWorld, config.fish);
    try {
      for (const id of remove) {
        inWorld.delete(id);
        const layout = await this.sim.removeFish(id);
        if (generation !== this.generation) return;
        this.stream.change(layout.epoch, layout.fishIds);
      }
      for (const spawn of add) {
        inWorld.add(spawn.id);
        const at = this.placement(spawn.id);
        const layout = await (at === undefined
          ? this.sim.addFish(spawn)
          : this.sim.addFish(spawn, at));
        if (generation !== this.generation) return;
        this.stream.change(layout.epoch, layout.fishIds);
      }
    } catch (cause) {
      if (this.disposed || generation !== this.generation) return;
      this.report('A fish could not join or leave the running tank; respawning all fish', cause);
      this.stopWorld();
      this.holdSwimming();
      this.dirty = true;
    }
  }

  /** Where the fish is on screen (its bag); undefined if it isn't shown. */
  private placement(simId: string): FishPlacement | undefined {
    const rt = this.runtimes.get(simId);
    if (rt === undefined || !rt.shown) return undefined;
    this.forward.set(0, 0, 1).applyQuaternion(rt.lastQuaternion);
    const p = rt.lastPosition;
    return {
      position: [p.x, p.y, p.z],
      heading: Math.atan2(this.forward.x, this.forward.z),
    };
  }

  private async reinit(config: TankSpaceWorldConfig): Promise<void> {
    const generation = this.generation;
    const init = initSim({
      client: this.sim,
      worker: this.worker,
      config,
      signal: this.lifetime.signal,
      timeoutMs: SIM_INIT_TIMEOUT_MS,
    });
    try {
      await startWorld(this.sim, this.spec, config, init, {
        current: () => !this.disposed && generation === this.generation,
        light: () => this.light,
        begin: (ready) => {
          this.simReady = true;
          this.inWorld = new Set(ready.fishIds);
          this.stream.begin(ready.epoch, ready.fishIds);
        },
      });
    } catch (cause) {
      if (cause instanceof SimInitTimeout && this.started && !this.disposed) this.replaceWorker();
      throw cause;
    }
  }

  private connectSim(worker: Worker): SimClient {
    const sim = new SimClient(worker);
    sim.onError(this.simErrors.receive);
    worker.addEventListener('error', this.simErrors.workerFailed);
    sim.onSnapshot((snapshot) => this.stream.push(snapshot, performance.now()));
    sim.onAte((events) => {
      const bites = this.roster.translateAte(events);
      if (bites.length === 0) return;
      for (const listener of this.ateListeners) listener(bites);
    });
    return sim;
  }

  /**
   * A worker that never answered `init` would refuse every later one ("init already in flight"),
   * so it goes, with its world, and the next stock change starts a fresh world in a new worker.
   */
  private replaceWorker(): void {
    this.stopWorld();
    this.simReady = false;
    this.sim.dispose();
    this.worker.terminate();
    this.worker = spawnSimWorker();
    this.sim = this.connectSim(this.worker);
  }

  private applyShadows(batch: SpeciesBatch): void {
    const cast = (this.shadows?.shadowMapSize ?? 0) > 0;
    batch.lods.forEach((lod, level) => {
      const castShadow = cast && level < SHADOW_LODS;
      for (const mesh of lod.meshes) {
        if (mesh.castShadow !== castShadow) lod.warmed = false;
        mesh.castShadow = castShadow;
      }
    });
  }

  /**
   * `retexturing` batches keep what they have when it may wait: their reload builds them with these
   * features, and a sync pass that ends without reloading them catches them up.
   */
  private applyFeatures(tier: Tier, retexturing: ReadonlySet<SpeciesBatch> = new Set()): void {
    const features = featuresFor(tier, {
      msaa: this.engine.renderer.samples > 1,
      temporal: this.engine.temporalResolve,
    });
    if (sameFeatures(this.features, features)) return;
    this.features = features;
    for (const batch of this.batches.values()) {
      if (!retexturing.has(batch) || !waitsForReload(batch.features, features)) {
        this.setBatchFeatures(batch, features);
      }
    }
  }

  /** Brings every batch a reload did not rebuild up to the current features. */
  private catchUpFeatures(): void {
    const features = this.features;
    if (features === null) return;
    for (const batch of this.batches.values()) {
      if (!sameFeatures(batch.features, features)) this.setBatchFeatures(batch, features);
    }
  }

  private setBatchFeatures(batch: SpeciesBatch, features: FishMaterialFeatures): void {
    for (const lod of batch.lods) {
      for (const m of lod.materials) m.setFeatures(features);
      lod.warmed = false;
    }
    batch.features = features;
  }

  /** Poses `rt` into `position`/`quaternion`/`pose`; false when it has nowhere to be drawn yet. */
  private place(rt: FishRuntime, deltaS: number, frame: Float32Array | null): boolean {
    const pose = this.pose;
    const { fish } = rt;
    pose.thrust = 1;
    const walk = this.walkSample;
    walk.state = -1;
    walk.legPhase = rt.motion instanceof WalkState ? rt.motion.legPhase : 0;
    walk.flip = 0;
    walk.attached = 1;
    if (fish.phase === 'swimming') {
      const o = frame === null ? undefined : this.stream.layout?.offsets.get(fish.simId);
      let presence: FramePresence;
      if (frame === null) presence = 'no-frame';
      else if (o === undefined) presence = 'missing';
      else presence = 'present';
      const held = this.held.step(fish.simId, this.clockS, presence);
      if (held === 'wait') {
        this.position.copy(rt.lastPosition);
        this.quaternion.copy(rt.lastQuaternion);
        pose.speed = 0;
        pose.yawRate = 0;
        pose.liveliness = 1;
        return true;
      }
      if (frame !== null && o !== undefined) {
        if (rt.bagSlot !== null || held === 'join') {
          rt.bagSlot = null;
          if (rt.shown) {
            rt.handover = HANDOVER_S;
            rt.fromPosition.copy(rt.lastPosition);
            rt.fromQuaternion.copy(rt.lastQuaternion);
          }
        }
        this.position.set(
          frame[o + SnapshotField.PosX] ?? 0,
          frame[o + SnapshotField.PosY] ?? 0,
          frame[o + SnapshotField.PosZ] ?? 0,
        );
        this.quaternion.set(
          frame[o + SnapshotField.QuatX] ?? 0,
          frame[o + SnapshotField.QuatY] ?? 0,
          frame[o + SnapshotField.QuatZ] ?? 0,
          frame[o + SnapshotField.QuatW] ?? 1,
        );
        pose.speed = frame[o + SnapshotField.Speed] ?? 0;
        pose.yawRate = frame[o + SnapshotField.YawRate] ?? 0;
        pose.liveliness = 1;
        pose.thrust = frame[o + SnapshotField.Thrust] ?? 1;
        walk.state = frame[o + SnapshotField.State] ?? -1;
        walk.legPhase = frame[o + SnapshotField.LegPhase] ?? 0;
        walk.flip = frame[o + SnapshotField.Flip] ?? 0;
        walk.attached = frame[o + SnapshotField.Attached] ?? 1;
        if (rt.handover > 0) {
          const w = smoothstep01(rt.handover / HANDOVER_S);
          this.position.lerp(rt.fromPosition, w);
          this.quaternion.slerp(rt.fromQuaternion, w);
          rt.handover = Math.max(0, rt.handover - deltaS);
        }
        return true;
      }
      if (rt.bagSlot === null) return false;
    }
    let limpFrom: Quaternion | null = null;
    let limpWeight = 0;
    const { script } = rt;
    if (script !== null) {
      const t = this.clockS - script.startS;
      if (script.kind === 'sinking') {
        sinkingCarcass(t, script.anchor, rt.length, rt.seed, script.floorY, pose);
        limpFrom = script.fromQuaternion;
        limpWeight = 1 - smoothstep01(t / CARCASS.limpS);
      } else {
        const animate = script.kind === 'dying' ? dyingPose : deadPose;
        animate(t, script.anchor, rt.length, rt.seed, this.box, pose);
      }
    } else {
      rt.bagSlot ??= this.freeBagSlot();
      bagPose(this.clockS, rt.bagSlot, rt.length, rt.seed, this.box, pose);
      const centre = bagCentre(rt.bagSlot, this.box);
      this.bags.place(
        fish.simId,
        centre.x,
        bagHeight(this.clockS, rt.length, rt.seed, this.box),
        centre.z,
        bagRadius(rt.length),
      );
    }
    this.position.set(pose.x, pose.y, pose.z);
    quatFromYawPitchRoll(pose.yaw, pose.pitch, pose.roll, this.quat, 0);
    this.quaternion.fromArray(this.quat);
    if (limpFrom !== null && limpWeight > 0) this.quaternion.slerp(limpFrom, limpWeight);
    return true;
  }

  /** `curl` for the walker just placed, cut short where it would put the tail into the sand. */
  private curlAboveFloor(rt: FishRuntime, curl: number): number {
    const { tail } = rt.batch.model;
    if (tail === null)
      throw new Error(`fish ${rt.batch.model.entry.id}: a walker needs a tail rig`);
    const { position } = this;
    const floorY = this.box.ground(position.x, position.z);
    return curlAboveFloor(curl, tail, rt.scale, position, this.quaternion, floorY);
  }

  private update(deltaS: number, nowMs: number): void {
    this.clockS += deltaS;
    const frame = this.stream.sample(nowMs);
    const sceneRevision = this.engine.sceneRevision;
    const rewarm = sceneRevision !== this.sceneRevision;
    this.sceneRevision = sceneRevision;
    for (const batch of this.batches.values()) {
      for (const lod of batch.lods) {
        lod.count = 0;
        if (rewarm) lod.warmed = false;
      }
    }
    this.bags.begin();

    const camera = this.engine.camera.position;
    for (const rt of this.runtimes.values()) {
      if (!this.place(rt, deltaS, frame)) {
        rt.shown = false;
        continue;
      }
      const { liveliness } = this.pose;
      const { motion } = rt;
      if (motion instanceof WalkState) {
        this.walkSample.speed = this.pose.speed;
        motion.advance(deltaS * liveliness, this.walkSample);
      } else {
        motion.advance(deltaS * liveliness, this.pose);
      }
      rt.lastPosition.copy(this.position);
      rt.lastQuaternion.copy(this.quaternion);
      rt.shown = true;

      const lods = rt.batch.lods;
      rt.lod = selectLod(
        this.position.distanceTo(camera),
        rt.length,
        this.thresholds,
        rt.lod,
        lods.length,
      );
      const lod = lods[rt.lod];
      if (lod === undefined) continue;
      const slot = lod.count++;
      this.scale.setScalar(rt.scale);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      lod.matrices.set(this.matrix.elements, slot * 16);
      const v = this.values;
      v.qx = this.quaternion.x;
      v.qy = this.quaternion.y;
      v.qz = this.quaternion.z;
      v.qw = this.quaternion.w;
      v.scale = rt.scale;
      const swim = motion instanceof SwimState ? motion : null;
      v.phase = swim?.phase ?? 0;
      v.amplitude = (swim?.amplitude ?? 0) * liveliness;
      v.curvature = (swim?.curvature ?? 0) * rt.scale * liveliness;
      v.finPhase = motion instanceof SwimState ? motion.finPhase : motion.clock;
      v.pale = Math.max(
        rt.condition,
        rt.fish.phase === 'dead' ? 1 - liveliness : 0,
        this.night * rt.batch.profile.nightPaling,
      );
      v.seed = rt.seed;
      v.filmThickness = rt.filmThickness;
      v.tint = rt.tint;
      v.gills = (swim?.gillOpening ?? 0) * liveliness;
      lod.instances.write(slot, v);
      if (motion instanceof WalkState) {
        const w = this.walker;
        w.legPhase = motion.legPhase;
        w.stride = motion.stride * liveliness;
        w.curl = this.curlAboveFloor(rt, motion.curl * liveliness);
        w.paddle = motion.paddle * liveliness;
        w.pick = motion.pick * liveliness;
        w.dance = motion.dance * liveliness;
        lod.instances.writeWalker(slot, w);
      }
    }
    this.bags.end();

    for (const batch of this.batches.values()) {
      for (const lod of batch.lods) {
        commitLodDraw(lod);
        lod.matrices.needsUpdate = true;
        lod.instances.commit();
      }
    }
  }
}
