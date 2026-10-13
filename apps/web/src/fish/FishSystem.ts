import type { Biome } from '@aquarium/shared';
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
  quatFromYawPitchRoll,
  Rng,
  SimClient,
  SNAPSHOT_STRIDE,
  SnapshotField,
  SnapshotInterpolator,
  STEP_DT,
  type SimReady,
  type SpeciesInput,
  type Stimulus,
  type WorldConfig,
} from '@aquarium/sim';
import type { Engine } from '../engine/Engine';
import type { EventBus } from '../engine/events';
import { TIER_SETTINGS, type Tier, type TierSettings } from '../engine/quality/tiers';
import { waterBounds, type TankDimensions } from '../engine/tank/dimensions';
import type { InteractionEvents } from '../interaction/events';
import { disposeFishModel, FishAssetLoader, type FishModel } from './assets';
import { AcclimationBags } from './bag';
import type { SceneAnchor } from '../scene/anemone';
import { demoTank, type DemoTank } from './demoStock';
import { FishInstanceData, type InstanceValues } from './instances';
import { selectLod, type LodThresholds } from './lod';
import { FishMaterial, type FinRendering, type FishMaterialFeatures } from './material';
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
import { renderProfile, type FishRenderProfile } from './profiles';
import { hashString, TankRoster, type RosterFish } from './roster';
import { SimWorldSpec } from './simWorld';
import { speciesInput } from './species';
import type { FishBite, PickRay, TankEvent } from './start';
import { SWIM_MODES, SwimState } from './swim';

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
  readonly model: FishModel;
  readonly profile: FishRenderProfile;
  lods: readonly LodBatch[];
  capacity: number;
}

interface Script {
  readonly kind: 'dying' | 'dead';
  readonly startS: number;
  readonly anchor: Anchor;
}

interface FishRuntime {
  readonly fish: RosterFish;
  readonly batch: SpeciesBatch;
  readonly length: number;
  readonly scale: number;
  readonly swim: SwimState;
  readonly seed: number;
  readonly tint: readonly [number, number, number];
  readonly filmThickness: number;
  readonly condition: number;
  lod: number;
  /** Drawn last frame, at `lastPosition`/`lastQuaternion`. */
  shown: boolean;
  readonly lastPosition: Vector3;
  readonly lastQuaternion: Quaternion;
  /** Seconds left of the blend from `fromPosition` into a new sim world's pose. */
  handover: number;
  readonly fromPosition: Vector3;
  readonly fromQuaternion: Quaternion;
  bagSlot: number | null;
  script: Script | null;
}

interface Layout {
  readonly epoch: number;
  readonly frame: Float32Array;
  readonly offsets: ReadonlyMap<string, number>;
}

/**
 * Translucent fins dither under the temporal resolve, which averages the pattern into a blend.
 * Elsewhere they use alpha-to-coverage, which needs the MSAA the engine only enables below DPR 2;
 * without it they fall back to the cutout.
 */
function featuresFor(tier: Tier, msaa: boolean): FishMaterialFeatures {
  const temporal = TIER_SETTINGS[tier].postChain === 'taa-bloom';
  const fins: FinRendering = temporal
    ? 'stochastic'
    : tier !== 'low' && msaa
      ? 'coverage'
      : 'cutout';
  return {
    fins,
    iridescence: tier === 'high' || tier === 'ultra',
    clearcoat: tier !== 'low',
  };
}

/** LOD levels near enough for their self-shadowing to read. */
const SHADOW_LODS = 2;
/**
 * Re-initialising the sim respawns every fish (it cannot add or remove one in place), so fish
 * already on screen glide from where they were into the new world over this long.
 */
const HANDOVER_S = 1.2;
/** Fingertip slop when netting a small fish, in metres. */
const MIN_PICK_RADIUS = 0.02;
const MIN_CAPACITY = 4;
/** How much a sick fish (health 0) pales; death pales it fully. */
const SICK_PALING = 0.7;

function sameFeatures(a: FishMaterialFeatures | null, b: FishMaterialFeatures): boolean {
  return (
    a !== null &&
    a.fins === b.fins &&
    a.iridescence === b.iridescence &&
    a.clearcoat === b.clearcoat
  );
}

function capacityFor(needed: number): number {
  let capacity = MIN_CAPACITY;
  while (capacity < needed) capacity *= 2;
  return capacity;
}

function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** A worker whose script fails to load never answers `init`, so its error event settles it. */
function initSim(
  client: SimClient,
  worker: Worker,
  config: WorldConfig,
  signal: AbortSignal,
): Promise<SimReady> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void): void => {
      worker.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      finish();
    };
    const onError = (event: ErrorEvent): void =>
      settle(() => reject(new Error(`Fish sim worker failed to start: ${event.message}`)));
    const onAbort = (): void => settle(() => reject(signal.reason));
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    worker.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort);
    client.init(config).then(
      (ready) => settle(() => resolve(ready)),
      (cause: unknown) => settle(() => reject(cause)),
    );
  });
}

/**
 * Streams the 30 Hz sim from its worker, interpolates it at render rate, and draws every fish as
 * instanced, kinematically deformed meshes. The renderer never steps behaviour itself: swimming
 * fish come from the sim, while bagged, dying and dead ones follow the fixed poses in `poses.ts`.
 *
 * Which fish exist is the `TankRoster`'s job: the demo stock, or a saved tank driven by the
 * `tank:*` events. Each change to the swimming set re-initialises the sim world.
 */
export class FishSystem {
  readonly group = new Group();
  private readonly roster: TankRoster;
  private readonly runtimes = new Map<string, FishRuntime>();
  private readonly batches = new Map<string, SpeciesBatch>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly unavailable = new Set<string>();
  private readonly interpolator = new SnapshotInterpolator(STEP_DT);
  private readonly loader: FishAssetLoader;
  private readonly bags: AcclimationBags;
  private readonly lifetime = new AbortController();
  private readonly offset: Vector3;
  private readonly box: WaterBox;
  private readonly spec: SimWorldSpec;
  private readonly cleanups: (() => void)[] = [];
  private readonly ateListeners = new Set<(events: readonly FishBite[]) => void>();
  private layout: Layout | null = null;
  private pendingLayout: { epoch: number; ids: readonly string[] } | null = null;
  private simRevision = -1;
  private simReady = false;
  private dirty = false;
  private syncing = false;
  private clockS = 0;
  private thresholds: LodThresholds = { midDistance: 1, impostorDistance: 3 };
  private shadows: Readonly<TierSettings> | null = null;
  private features: FishMaterialFeatures | null = null;
  private night = 0;
  private light = 1;
  private disposed = false;

  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3();
  private readonly forward = new Vector3();
  private readonly quat = new Float32Array(4);
  private readonly pose = createPose();
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
    const worker = new Worker(new URL('./simWorker.ts', import.meta.url), {
      type: 'module',
      name: 'fish-sim',
    });
    const client = new SimClient(worker);
    const system = new FishSystem(engine, client, worker, options, demo, seed);
    const onAbort = (): void => system.dispose();
    signal.addEventListener('abort', onAbort);
    system.cleanups.push(() => signal.removeEventListener('abort', onAbort));
    try {
      await system.loadSpecies();
      signal.throwIfAborted();
      system.materialize();
      await system.reinit();
      signal.throwIfAborted();
    } catch (cause) {
      system.dispose();
      throw signal.aborted ? signal.reason : cause;
    }
    worker.addEventListener('error', (event) =>
      system.report(`Fish sim worker failed: ${event.message}`),
    );
    client.onError((message) => system.report(`Fish sim: ${message}`));
    return system;
  }

  private constructor(
    private readonly engine: Engine,
    private readonly sim: SimClient,
    private readonly worker: Worker,
    private readonly options: FishSystemOptions,
    demo: DemoTank,
    private readonly seed: number,
  ) {
    this.offset = new Vector3(...demo.offset);
    const bounds = waterBounds(options.tank);
    this.box = {
      minX: bounds.min.x,
      maxX: bounds.max.x,
      minY: demo.offset[1],
      minZ: bounds.min.z,
      maxZ: bounds.max.z,
      top: bounds.max.y,
    };
    this.roster = new TankRoster(demo.config.fish);
    this.spec = new SimWorldSpec(demo, seed);
    this.loader = new FishAssetLoader(engine.renderer, options.assetRoot);
    this.group.name = 'fish';
    this.bags = new AcclimationBags(this.group);
    engine.scene.add(this.group);
    this.cleanups.push(
      () => this.group.removeFromParent(),
      () => {
        this.sim.dispose();
        this.worker.terminate();
      },
      () => this.loader.dispose(),
      () => this.bags.dispose(),
      () => {
        for (const batch of this.batches.values()) {
          this.disposeLods(batch);
          disposeFishModel(batch.model);
        }
        this.batches.clear();
        this.runtimes.clear();
      },
    );
    sim.onSnapshot((snapshot) => {
      const pending = this.pendingLayout;
      if (pending !== null && snapshot.epoch === pending.epoch) this.switchLayout(pending);
      if (this.layout === null || snapshot.epoch !== this.layout.epoch) {
        sim.recycle(snapshot);
        return;
      }
      const evicted = this.interpolator.push(snapshot, performance.now());
      if (evicted !== null) sim.recycle(evicted);
    });
    sim.onAte((events) => {
      const bites = this.roster.translateAte(events);
      if (bites.length === 0) return;
      for (const listener of this.ateListeners) listener(bites);
    });
    this.cleanups.push(
      engine.quality.register('fish-lod', (s) => {
        this.thresholds = s.fishLod;
      }),
      engine.quality.register('fish-shadows', (s) => {
        this.shadows = s;
        for (const batch of this.batches.values()) this.applyShadows(batch);
      }),
      engine.quality.register('fish-materials', (_s, tier) => this.applyFeatures(tier)),
      engine.onFrame((deltaS, nowMs) => this.update(deltaS, nowMs)),
      engine.events.on('engine:daylight', ({ level }) => this.setDaylight(level)),
    );
    this.setDaylight(engine.daylight);
  }

  /** Applies a saved-tank event; see `InteractionEvents` for the contract. */
  handle(event: TankEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'tank:loaded':
        this.roster.load(event.payload);
        this.stopWorld();
        break;
      case 'tank:unloaded':
        if (this.roster.unload(event.payload)) this.stopWorld();
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
      case 'tank:fish-removed':
        this.roster.removed(event.payload);
        break;
    }
    this.prune();
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

  /**
   * `stimulus.position` is in the sim's frame (y above the substrate). The demo sim's floor is flat
   * at the highest substrate point, so a low-ground tap reads up to a few cm high until #64.
   */
  startle(stimulus: Stimulus): void {
    if (!this.disposed && this.simReady) this.sim.startle(stimulus);
  }

  /**
   * Homes from the scene, in engine space: the clownfish's anemone. Kept for every later sim
   * world, since a re-initialised world starts with only the anchors in its config.
   */
  setAnchors(anchors: readonly SceneAnchor[]): void {
    if (this.disposed) return;
    const simAnchors = this.spec.setAnchors(anchors);
    if (this.simReady) this.sim.setAnchors(simAnchors);
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
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }

  private report(message: string, cause?: unknown): void {
    if (this.disposed) return;
    this.engine.events.emit('engine:error', cause === undefined ? { message } : { message, cause });
  }

  private requestSync(): void {
    this.dirty = true;
    if (this.syncing) return;
    this.syncing = true;
    void this.runSync().finally(() => {
      this.syncing = false;
    });
  }

  /** One pass at a time, so sim inits never overlap; changes made meanwhile run another pass. */
  private async runSync(): Promise<void> {
    while (this.dirty && !this.disposed) {
      this.dirty = false;
      try {
        await this.loadSpecies();
        if (this.disposed) return;
        this.materialize();
        if (this.roster.revision !== this.simRevision) await this.reinit();
      } catch (cause) {
        if (this.disposed) return;
        this.report('Fish could not be updated for the new tank stock', cause);
      }
    }
  }

  /** Loads the model of every species in the roster; a species that fails stays unseen. */
  private async loadSpecies(): Promise<void> {
    const wanted = new Set<string>();
    for (const fish of this.roster.entries()) wanted.add(fish.species);
    await Promise.all([...wanted].map((species) => this.loadBatch(species)));
  }

  private loadBatch(species: string): Promise<void> {
    if (this.batches.has(species) || this.unavailable.has(species)) return Promise.resolve();
    let pending = this.loading.get(species);
    if (pending === undefined) {
      pending = this.createBatch(species).finally(() => this.loading.delete(species));
      this.loading.set(species, pending);
    }
    return pending;
  }

  private async createBatch(species: string): Promise<void> {
    const input = speciesInput(species);
    if (input === undefined) {
      this.unavailable.add(species);
      this.report(`Fish species "${species}" has no content in this build; it stays hidden`);
      return;
    }
    let model: FishModel;
    let profile: FishRenderProfile;
    try {
      profile = renderProfile(species);
      model = await this.loader.load(profile.assetId);
    } catch (cause) {
      this.unavailable.add(species);
      this.report(`Fish "${species}" has no visual; it swims and eats unseen`, cause);
      return;
    }
    if (this.disposed) {
      disposeFishModel(model);
      return;
    }
    const batch: SpeciesBatch = { input, model, profile, lods: [], capacity: 0 };
    this.batches.set(species, batch);
  }

  /** Grows a species' instance buffers; the materials are rebuilt around the new ones. */
  private ensureCapacity(batch: SpeciesBatch, needed: number): void {
    if (needed <= batch.capacity) return;
    this.disposeLods(batch);
    const capacity = capacityFor(needed);
    const { model, profile, input } = batch;
    const mode = SWIM_MODES[input.locomotion.swimmingMode];
    const lighting = {
      lightDirection: this.engine.caustics.lightDirection,
      lightRadiance: this.engine.caustics.lightRadiance,
    };
    batch.lods = model.lods.map((parts, level) => {
      const instances = new FishInstanceData(capacity);
      const meshes: InstancedMesh[] = [];
      const materials: FishMaterial[] = [];
      for (const part of parts) {
        const material = new FishMaterial({
          source: part.source,
          profile,
          mode,
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

  /** Builds a runtime for every roster fish whose model is loaded. */
  private materialize(): void {
    const perSpecies = new Map<string, number>();
    for (const fish of this.roster.entries()) {
      perSpecies.set(fish.species, (perSpecies.get(fish.species) ?? 0) + 1);
    }
    for (const [species, count] of perSpecies) {
      const batch = this.batches.get(species);
      if (batch !== undefined) this.ensureCapacity(batch, count);
    }
    for (const fish of this.roster.entries()) {
      if (this.runtimes.has(fish.simId)) continue;
      const batch = this.batches.get(fish.species);
      if (batch !== undefined) this.runtimes.set(fish.simId, this.createRuntime(fish, batch));
    }
  }

  private createRuntime(fish: RosterFish, batch: SpeciesBatch): FishRuntime {
    const rng = new Rng((this.seed ^ hashString(fish.key)) >>> 0);
    const { profile, input } = batch;
    const length = fish.lengthM ?? input.locomotion.bodyLengthM;
    const v = profile.tintVariation;
    const brightness = 1 + v * rng.signed();
    const [lo, hi] = profile.filmThicknessNm;
    const seed = rng.next();
    const runtime: FishRuntime = {
      fish,
      batch,
      length,
      scale: length / batch.model.entry.standardLengthM,
      swim: new SwimState(
        length,
        input.locomotion.strouhal,
        SWIM_MODES[input.locomotion.swimmingMode],
        rng.next() * Math.PI * 2,
      ),
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
    if (fish.phase === 'dead') {
      runtime.script = {
        kind: 'dead',
        startS: this.clockS,
        anchor: deadAnchor(this.box, length, seed),
      };
    }
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
    rt.handover = 0;
    if (!rt.shown) {
      rt.script = {
        kind: 'dead',
        startS: this.clockS,
        anchor: deadAnchor(this.box, rt.length, rt.seed),
      };
      return;
    }
    this.forward.set(0, 0, 1).applyQuaternion(rt.lastQuaternion);
    const anchor: Anchor = {
      x: rt.lastPosition.x,
      y: rt.lastPosition.y,
      z: rt.lastPosition.z,
      yaw: Math.atan2(this.forward.x, this.forward.z),
    };
    rt.script = { kind: 'dying', startS: this.clockS, anchor };
  }

  /** Drops the runtimes of fish that left the roster. */
  private prune(): void {
    for (const [simId, rt] of this.runtimes) {
      if (this.roster.get(simId) !== rt.fish) this.runtimes.delete(simId);
    }
  }

  /** Until the next init nothing of the current world may show, eat or be blended from. */
  private stopWorld(): void {
    this.sim.stop();
    this.layout = null;
    this.pendingLayout = null;
    this.interpolator.reset();
  }

  private async reinit(): Promise<void> {
    const revision = this.roster.revision;
    const config = this.spec.config(this.roster.swimming());
    if (config === null) {
      this.stopWorld();
      this.simRevision = revision;
      return;
    }
    const ready = await initSim(this.sim, this.worker, config, this.lifetime.signal);
    if (this.disposed) return;
    this.simReady = true;
    this.sim.setLight(this.light);
    this.simRevision = revision;
    this.pendingLayout = { epoch: ready.epoch, ids: ready.fishIds };
    this.sim.start();
  }

  private switchLayout(pending: { epoch: number; ids: readonly string[] }): void {
    this.pendingLayout = null;
    this.layout = {
      epoch: pending.epoch,
      frame: new Float32Array(pending.ids.length * SNAPSHOT_STRIDE),
      offsets: new Map(pending.ids.map((id, i) => [id, i * SNAPSHOT_STRIDE])),
    };
    this.interpolator.reset();
    for (const rt of this.runtimes.values()) {
      if (!rt.shown || rt.fish.phase !== 'swimming') continue;
      rt.handover = HANDOVER_S;
      rt.fromPosition.copy(rt.lastPosition);
      rt.fromQuaternion.copy(rt.lastQuaternion);
    }
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

  private applyFeatures(tier: Tier): void {
    const features = featuresFor(tier, this.engine.renderer.samples > 1);
    if (sameFeatures(this.features, features)) return;
    this.features = features;
    for (const batch of this.batches.values()) {
      for (const lod of batch.lods) {
        for (const m of lod.materials) m.setFeatures(features);
        lod.warmed = false;
      }
    }
  }

  /** Poses `rt` into `position`/`quaternion`/`pose`; false when it has nowhere to be drawn yet. */
  private place(rt: FishRuntime, deltaS: number, frame: Float32Array | null): boolean {
    const pose = this.pose;
    const { fish } = rt;
    if (fish.phase === 'swimming') {
      const o = frame === null ? undefined : this.layout?.offsets.get(fish.simId);
      if (frame !== null && o !== undefined) {
        rt.bagSlot = null;
        this.position
          .set(
            frame[o + SnapshotField.PosX] ?? 0,
            frame[o + SnapshotField.PosY] ?? 0,
            frame[o + SnapshotField.PosZ] ?? 0,
          )
          .add(this.offset);
        this.quaternion.set(
          frame[o + SnapshotField.QuatX] ?? 0,
          frame[o + SnapshotField.QuatY] ?? 0,
          frame[o + SnapshotField.QuatZ] ?? 0,
          frame[o + SnapshotField.QuatW] ?? 1,
        );
        pose.speed = frame[o + SnapshotField.Speed] ?? 0;
        pose.yawRate = frame[o + SnapshotField.YawRate] ?? 0;
        pose.liveliness = 1;
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
    if (rt.script !== null) {
      const t = this.clockS - rt.script.startS;
      const animate = rt.script.kind === 'dying' ? dyingPose : deadPose;
      animate(t, rt.script.anchor, rt.length, rt.seed, this.box, pose);
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
    return true;
  }

  private update(deltaS: number, nowMs: number): void {
    this.clockS += deltaS;
    const layout = this.layout;
    const frame =
      layout !== null && this.interpolator.sample(nowMs, layout.frame) ? layout.frame : null;
    for (const batch of this.batches.values()) for (const lod of batch.lods) lod.count = 0;
    this.bags.begin();

    const camera = this.engine.camera.position;
    for (const rt of this.runtimes.values()) {
      if (!this.place(rt, deltaS, frame)) {
        rt.shown = false;
        continue;
      }
      const { liveliness, speed, yawRate } = this.pose;
      rt.swim.advance(deltaS * liveliness, { speed, yawRate });
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
      v.phase = rt.swim.phase;
      v.amplitude = rt.swim.amplitude * liveliness;
      v.curvature = rt.swim.curvature * rt.scale * liveliness;
      v.finPhase = rt.swim.finPhase;
      v.pale = Math.max(
        rt.condition,
        rt.fish.phase === 'dead' ? 1 - liveliness : 0,
        this.night * rt.batch.profile.nightPaling,
      );
      v.seed = rt.seed;
      v.filmThickness = rt.filmThickness;
      v.tint = rt.tint;
      lod.instances.write(slot, v);
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
