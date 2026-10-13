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
import type { Tier, TierSettings } from '../engine/quality/tiers';
import type { TankDimensions } from '../engine/tank/dimensions';
import { disposeFishModel, FishAssetLoader, type FishModel } from './assets';
import { demoTank } from './demoStock';
import { FishInstanceData, type InstanceValues } from './instances';
import { selectLod, type LodThresholds } from './lod';
import { FishMaterial, type FinRendering, type FishMaterialFeatures } from './material';
import { renderProfile, type FishRenderProfile } from './profiles';
import { SWIM_MODES, SwimState } from './swim';

export interface FishSystemOptions {
  readonly tank: TankDimensions;
  /** Folder holding `index.json` and the fish GLBs, with a trailing slash. */
  readonly assetRoot: string;
  readonly seed?: number;
  readonly signal: AbortSignal;
}

interface LodBatch {
  readonly instances: FishInstanceData;
  readonly matrices: InstancedBufferAttribute;
  readonly meshes: readonly InstancedMesh[];
  readonly materials: readonly FishMaterial[];
  count: number;
}

interface SpeciesBatch {
  readonly model: FishModel;
  readonly profile: FishRenderProfile;
  readonly lods: readonly LodBatch[];
}

interface FishRuntime {
  readonly id: string;
  readonly offset: number;
  readonly batch: SpeciesBatch;
  readonly length: number;
  readonly scale: number;
  readonly swim: SwimState;
  readonly seed: number;
  readonly tint: readonly [number, number, number];
  readonly filmThickness: number;
  lod: number;
  condition: number;
}

/**
 * No tier has a temporal resolve yet (T15), so translucent fins use alpha-to-coverage, which needs
 * the MSAA the engine only enables below DPR 2; without it they fall back to the cutout.
 */
function featuresFor(tier: Tier, msaa: boolean): FishMaterialFeatures {
  const fins: FinRendering = tier !== 'low' && msaa ? 'coverage' : 'cutout';
  return {
    fins,
    iridescence: tier === 'high' || tier === 'ultra',
    clearcoat: tier !== 'low',
  };
}

/** LOD levels near enough for their self-shadowing to read. */
const SHADOW_LODS = 2;

function sameFeatures(a: FishMaterialFeatures | null, b: FishMaterialFeatures): boolean {
  return (
    a !== null &&
    a.fins === b.fins &&
    a.iridescence === b.iridescence &&
    a.clearcoat === b.clearcoat
  );
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
 * instanced, kinematically deformed meshes. The renderer never steps behaviour itself.
 */
export class FishSystem {
  readonly group = new Group();
  private readonly fish: FishRuntime[] = [];
  private readonly batches: SpeciesBatch[] = [];
  private readonly interpolator = new SnapshotInterpolator(STEP_DT);
  private readonly frame: Float32Array;
  private readonly offset: Vector3;
  private readonly cleanups: (() => void)[] = [];
  private thresholds: LodThresholds = { midDistance: 1, impostorDistance: 3 };
  private features: FishMaterialFeatures | null = null;
  private night = 0;
  private disposed = false;

  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3();
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
    const demo = demoTank(options.tank, seed);
    const loader = new FishAssetLoader(engine.renderer, options.assetRoot);
    const models = new Map<string, FishModel>();
    try {
      const results = await Promise.allSettled(
        demo.config.species.map(async (species) => {
          const model = await loader.load(renderProfile(species.id).assetId);
          models.set(species.id, model);
        }),
      );
      if (signal.aborted) {
        for (const model of models.values()) disposeFishModel(model);
        signal.throwIfAborted();
      }
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          engine.events.emit('engine:error', {
            message: `Fish "${demo.config.species[i]?.id}" could not be loaded; it stays hidden`,
            cause: result.reason,
          });
        }
      });
    } finally {
      loader.dispose();
    }

    const worker = new Worker(new URL('./simWorker.ts', import.meta.url), {
      type: 'module',
      name: 'fish-sim',
    });
    const client = new SimClient(worker);
    const system = new FishSystem(engine, client, demo.offset, demo.config.fish.length);
    system.cleanups.push(() => {
      client.dispose();
      worker.terminate();
    });
    try {
      const ready = await initSim(client, worker, demo.config, signal);
      worker.addEventListener('error', (event) =>
        engine.events.emit('engine:error', { message: `Fish sim worker failed: ${event.message}` }),
      );
      client.onError((message) =>
        engine.events.emit('engine:error', { message: `Fish sim: ${message}` }),
      );
      system.build(engine, ready.fishIds, demo.config.species, demo.config.fish, models, seed);
    } catch (cause) {
      const owned = new Set(system.batches.map((b) => b.model));
      for (const model of models.values()) if (!owned.has(model)) disposeFishModel(model);
      system.dispose();
      throw cause;
    }
    client.onSnapshot((snapshot) => {
      const evicted = system.interpolator.push(snapshot, performance.now());
      if (evicted !== null) client.recycle(evicted);
    });
    client.start();
    return system;
  }

  private constructor(
    private readonly engine: Engine,
    private readonly sim: SimClient,
    offset: readonly [number, number, number],
    count: number,
  ) {
    this.offset = new Vector3(...offset);
    this.frame = new Float32Array(count * SNAPSHOT_STRIDE);
    this.group.name = 'fish';
    engine.scene.add(this.group);
    this.cleanups.push(() => this.group.removeFromParent());
  }

  private build(
    engine: Engine,
    fishIds: readonly string[],
    species: readonly SpeciesInput[],
    spawns: readonly { id: string; species: string; bodyLengthM?: number }[],
    models: ReadonlyMap<string, FishModel>,
    seed: number,
  ): void {
    const rng = new Rng(seed ^ 0x5f3759df);
    const speciesById = new Map(species.map((s) => [s.id, s]));
    const spawnById = new Map(spawns.map((s) => [s.id, s]));
    const counts = new Map<string, number>();
    for (const spawn of spawns) counts.set(spawn.species, (counts.get(spawn.species) ?? 0) + 1);

    const batchBySpecies = new Map<string, SpeciesBatch>();
    for (const [speciesId, model] of models) {
      const input = speciesById.get(speciesId);
      if (input === undefined) continue;
      const batch = this.createBatch(engine, input, model, counts.get(speciesId) ?? 1);
      batchBySpecies.set(speciesId, batch);
    }

    fishIds.forEach((id, index) => {
      const spawn = spawnById.get(id);
      if (spawn === undefined) throw new Error(`fish sim returned unknown fish "${id}"`);
      const batch = batchBySpecies.get(spawn.species);
      const input = speciesById.get(spawn.species);
      if (batch === undefined || input === undefined) return;
      const { profile } = batch;
      const length = spawn.bodyLengthM ?? input.locomotion.bodyLengthM;
      const v = profile.tintVariation;
      const brightness = 1 + v * rng.signed();
      const [lo, hi] = profile.filmThicknessNm;
      this.fish.push({
        id,
        offset: index * SNAPSHOT_STRIDE,
        batch,
        length,
        scale: length / batch.model.entry.standardLengthM,
        swim: new SwimState(
          length,
          input.locomotion.strouhal,
          SWIM_MODES[input.locomotion.swimmingMode],
          rng.next() * Math.PI * 2,
        ),
        seed: rng.next(),
        tint: [
          brightness * (1 + 0.5 * v * rng.signed()),
          brightness * (1 + 0.5 * v * rng.signed()),
          brightness * (1 + 0.5 * v * rng.signed()),
        ],
        filmThickness: lo + (hi - lo) * rng.next(),
        lod: 0,
        condition: 0,
      });
    });

    this.cleanups.push(
      engine.quality.register('fish-lod', (s) => {
        this.thresholds = s.fishLod;
      }),
      engine.quality.register('fish-shadows', (s) => this.applyShadows(s)),
      engine.quality.register('fish-materials', (_s, tier) => this.applyFeatures(tier)),
      engine.onFrame((deltaS, nowMs) => this.update(deltaS, nowMs)),
    );
  }

  private createBatch(
    engine: Engine,
    input: SpeciesInput,
    model: FishModel,
    capacity: number,
  ): SpeciesBatch {
    const profile = renderProfile(input.id);
    const mode = SWIM_MODES[input.locomotion.swimmingMode];
    const lighting = {
      lightDirection: engine.caustics.lightDirection,
      lightRadiance: engine.caustics.lightRadiance,
    };
    const lods = model.lods.map((parts, level) => {
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
      return { instances, matrices, meshes, materials, count: 0 };
    });
    const batch = { model, profile, lods };
    this.batches.push(batch);
    this.cleanups.push(() => {
      for (const lod of lods) {
        for (const mesh of lod.meshes) mesh.dispose();
        for (const material of lod.materials) material.dispose();
      }
      disposeFishModel(model);
    });
    return batch;
  }

  private applyShadows(settings: Readonly<TierSettings>): void {
    const cast = settings.shadowMapSize > 0;
    for (const batch of this.batches) {
      batch.lods.forEach((lod, level) => {
        for (const mesh of lod.meshes) mesh.castShadow = cast && level < SHADOW_LODS;
      });
    }
  }

  private applyFeatures(tier: Tier): void {
    const features = featuresFor(tier, this.engine.renderer.samples > 1);
    if (sameFeatures(this.features, features)) return;
    this.features = features;
    for (const batch of this.batches) {
      for (const lod of batch.lods) for (const m of lod.materials) m.setFeatures(features);
    }
  }

  /**
   * `stimulus.position` is in the sim's frame (y above the substrate). The demo sim's floor is flat
   * at the highest substrate point, so a low-ground tap reads up to a few cm high until #64.
   */
  startle(stimulus: Stimulus): void {
    if (!this.disposed) this.sim.startle(stimulus);
  }

  /** 0 day .. 1 night; fish pale by their species' night sensitivity. */
  setNight(amount: number): void {
    this.night = Math.min(1, Math.max(0, amount));
  }

  /** 0 healthy .. 1 critically ill; a stressed fish loses its colour. */
  setCondition(fishId: string, paling: number): void {
    const fish = this.fish.find((f) => f.id === fishId);
    if (fish === undefined) throw new Error(`setCondition: no rendered fish "${fishId}"`);
    fish.condition = Math.min(1, Math.max(0, paling));
  }

  private update(deltaS: number, nowMs: number): void {
    const frame = this.frame;
    if (!this.interpolator.sample(nowMs, frame)) return;
    for (const batch of this.batches) for (const lod of batch.lods) lod.count = 0;

    const camera = this.engine.camera.position;
    for (const fish of this.fish) {
      const o = fish.offset;
      const speed = frame[o + SnapshotField.Speed] ?? 0;
      const yawRate = frame[o + SnapshotField.YawRate] ?? 0;
      fish.swim.advance(deltaS, { speed, yawRate });

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
      const lods = fish.batch.lods;
      fish.lod = selectLod(
        this.position.distanceTo(camera),
        fish.length,
        this.thresholds,
        fish.lod,
        lods.length,
      );
      const lod = lods[fish.lod];
      if (lod === undefined) continue;
      const slot = lod.count++;
      this.scale.setScalar(fish.scale);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      lod.matrices.set(this.matrix.elements, slot * 16);
      const v = this.values;
      v.qx = this.quaternion.x;
      v.qy = this.quaternion.y;
      v.qz = this.quaternion.z;
      v.qw = this.quaternion.w;
      v.scale = fish.scale;
      v.phase = fish.swim.phase;
      v.amplitude = fish.swim.amplitude;
      v.curvature = fish.swim.curvature * fish.scale;
      v.finPhase = fish.swim.finPhase;
      v.pale = Math.max(fish.condition, this.night * fish.batch.profile.nightPaling);
      v.seed = fish.seed;
      v.filmThickness = fish.filmThickness;
      v.tint = fish.tint;
      lod.instances.write(slot, v);
    }

    for (const batch of this.batches) {
      for (const lod of batch.lods) {
        lod.matrices.needsUpdate = true;
        lod.instances.commit();
        for (const mesh of lod.meshes) {
          mesh.count = lod.count;
          mesh.visible = lod.count > 0;
        }
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }
}
