import {
  AgXToneMapping,
  Color,
  DirectionalLight,
  PCFShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { daylightAt, minuteOfDay } from './daylight';
import { EffectsSlot } from './effectsSlot';
import { installRoomLighting, DEFAULT_HDRI_URL } from './environment';
import { EventBus, type BackendKind, type EngineEvents, type EngineEventBus } from './events';
import { CullPrewarm } from './cullPrewarm';
import { buildOrRelease, DisposeStack } from './lifecycle';
import type { EngineOptions } from './options';
import { qualityProfile } from './quality/profile';
import { QualityManager } from './quality/QualityManager';
import { renderPixelRatio } from './quality/tiers';
import { DEFAULT_TANK, type TankDimensions, waterBounds } from './tank/dimensions';
import { meanSubstrateHeight } from './tank/substrate';
import { Tank } from './tank/Tank';
import { Caustics } from './water/caustics';
import { InteriorLight } from './water/interior';
import { WaterMedium, type WaterQuality } from './water/medium';

export type FrameCallback = (deltaS: number, nowMs: number) => void;

export interface EngineConfig {
  options: EngineOptions;
  events?: EngineEventBus;
  tank?: TankDimensions;
  water?: WaterQuality;
  hdriUrl?: string;
}

const STATS_INTERVAL_MS = 500;
const DEFAULT_WATER: WaterQuality = { cdom440: 0.05, turbidity: 0.08 };
const MAX_DELTA_S = 0.1;

/** Hood LED, roughly 6500 K. */
const HOOD_COLOR = new Color(1, 0.97, 0.92);
/** At the water surface; the hood's spread leaves about three quarters of it on average below. */
const HOOD_INTENSITY = 4;
/** The hood's blue "moonlight" channel, left on through the night. */
const MOONLIGHT = new Color(0.04, 0.14, 0.9);
/** Room light at night relative to the day, from a lamp somewhere in the room. */
const ROOM_AT_NIGHT = 0.15;
const DAYLIGHT_INTERVAL_MS = 1000;
/** Smallest daylight change worth announcing: about 20 s into a one-hour ramp. */
const DAYLIGHT_EPSILON = 0.005;

function hasCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** The part of the renderer the start-up path needs, so failures can be tested without a GPU. */
export interface StartableRenderer {
  init(): Promise<unknown>;
  dispose(): Promise<void> | void;
  readonly backend: object;
}

export type RendererFactory<R extends StartableRenderer> = (
  parameters: ConstructorParameters<typeof WebGPURenderer>[0],
) => R;

/**
 * Creates and initialises the renderer, registering its disposal on `cleanup` before
 * anything can fail, so a rejected init() or a refused backend still frees the device.
 */
export async function initRenderer<R extends StartableRenderer>(
  options: EngineOptions,
  cleanup: DisposeStack,
  create: RendererFactory<R>,
  devicePixelRatio: number,
): Promise<{ renderer: R; backend: BackendKind }> {
  const renderer = create({
    forceWebGL: options.backend === 'webgl',
    antialias: devicePixelRatio < 2,
    trackTimestamp: true,
    powerPreference: 'high-performance',
  });
  cleanup.add(() => renderer.dispose());
  await renderer.init();
  const backend: BackendKind = 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl2';
  if (options.backend === 'webgpu' && backend !== 'webgpu') {
    throw new Error('WebGPU was requested with ?backend=webgpu but is not available here');
  }
  return { renderer, backend };
}

function configureRenderer(renderer: WebGPURenderer): void {
  renderer.toneMapping = AgXToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
}

export class Engine {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.05, 50);
  readonly medium: WaterMedium;
  readonly caustics: Caustics;
  readonly interior: InteriorLight;
  readonly tank: Tank;
  readonly hood = new DirectionalLight(HOOD_COLOR, HOOD_INTENSITY);
  /** Room light reaching the water from outside the hood, for in-scatter. */
  readonly ambientScatter = new Color(0.02, 0.03, 0.034);
  /** Linear albedo of the substrate, for the hood light it throws back: the dark freshwater sand. */
  readonly substrateAlbedo = new Color(0.13, 0.09, 0.055);
  readonly quality: QualityManager;

  private readonly clock: number | null;
  private readonly showStats: boolean;
  private daylightLevel = 1;
  private daylightCheckedAt = -Infinity;
  private daylightAnnounced = false;
  private readonly scratch = new Color();
  private readonly roomBackgroundIntensity: number;
  private readonly effects = new EffectsSlot((message, cause) => this.reportError(message, cause));
  private readonly frameCallbacks = new Set<FrameCallback>();
  private lastFrameAt: number | null = null;
  private readonly cullPrewarm = new CullPrewarm(this.scene);
  private sceneRevisionValue = 0;
  private gpuMs: number | null = null;
  private readonly gpuTiming: boolean;
  private lastGpuMs: number | null = null;
  private gpuPending = false;
  private stats = { frames: 0, frameMsSum: 0, since: 0 };

  /** Everything is released through `cleanup`, both on dispose() and on a failed start. */
  static async create(container: HTMLElement, config: EngineConfig): Promise<Engine> {
    const events = config.events ?? new EventBus<EngineEvents>();
    try {
      return await buildOrRelease(
        async (cleanup) => {
          const { renderer, backend } = await initRenderer(
            config.options,
            cleanup,
            (parameters) => new WebGPURenderer(parameters),
            window.devicePixelRatio,
          );
          configureRenderer(renderer);
          const engine = new Engine(container, renderer, backend, events, config, cleanup);
          await engine.warmUp();
          await engine.loadEffects();
          return engine;
        },
        (error) =>
          events.emit('engine:error', {
            message: 'Cleanup after a failed start failed',
            cause: error,
          }),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      events.emit('engine:error', { message: `Engine start failed: ${message}`, cause });
      throw cause;
    }
  }

  private constructor(
    readonly container: HTMLElement,
    readonly renderer: WebGPURenderer,
    readonly backend: BackendKind,
    readonly events: EngineEventBus,
    config: EngineConfig,
    private readonly cleanup: DisposeStack,
  ) {
    const dimensions = config.tank ?? DEFAULT_TANK;
    this.clock = config.options.clock;
    this.showStats = config.options.stats;
    this.gpuTiming = renderer.hasFeature('timestamp-query');
    const profile = qualityProfile(hasCoarsePointer());
    this.quality = new QualityManager(events, {
      gpuTiming: this.gpuTiming,
      pinned: config.options.tier,
      adaptive: config.options.adaptive,
      targetMs: profile.targetMs,
      refreshMs: profile.refreshMs,
      probeTier: profile.probeTier,
      maxTier: profile.maxTier,
    });

    container.appendChild(renderer.domElement);
    cleanup.add(() => renderer.domElement.remove());
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const roomLighting = installRoomLighting(
      renderer,
      this.scene,
      config.hdriUrl ?? DEFAULT_HDRI_URL,
      (message, cause) => this.reportError(message, cause),
      (environment) => {
        this.tank.setSky(environment);
        this.interior.setRoom(environment);
      },
    );
    cleanup.add(() => roomLighting.dispose());
    this.roomBackgroundIntensity = this.scene.backgroundIntensity;

    this.medium = new WaterMedium(waterBounds(dimensions), config.water ?? DEFAULT_WATER);
    this.caustics = new Caustics(this.medium);
    cleanup.add(() => this.caustics.dispose());
    this.interior = new InteriorLight(
      this.medium,
      this.caustics,
      roomLighting.initial,
      this.substrateAlbedo,
      meanSubstrateHeight(dimensions),
    );
    this.tank = new Tank(dimensions, this.medium, roomLighting.initial, this.interior);
    cleanup.add(() => this.tank.dispose());
    this.scene.add(this.tank.group);
    this.scene.fogNode = this.medium.fogNode();
    this.scene.environmentNode = this.interior.environmentNode();

    this.caustics.bake(renderer);
    this.setupHood(dimensions);
    cleanup.add(() => this.hood.shadow.dispose());

    this.camera.position.set(0, 0.35, 1.6);
    this.camera.lookAt(0, 0.25, 0);

    this.registerQualityFeatures();

    const resizeObserver = new ResizeObserver(() => this.resize());
    cleanup.add(() => resizeObserver.disconnect());
    resizeObserver.observe(container);
    this.resize();
  }

  get disposed(): boolean {
    return this.cleanup.isDisposed;
  }

  /** 0 = hood off (night, moonlight only) .. 1 = full day; follows the local clock or `?clock=`. */
  get daylight(): number {
    return this.daylightLevel;
  }

  /** Depth of field follows the focus camera, on tiers that allow it. */
  setFocusMode(on: boolean): void {
    this.effects.setFocusMode(on);
  }

  /**
   * Changes whenever new objects (lights included) join the scene. Every render object three built
   * before may then be rebuilt on its next draw, so hidden variants should be drawn again.
   */
  get sceneRevision(): number {
    return this.sceneRevisionValue;
  }

  /** Called once per rendered frame before the scene is drawn. */
  onFrame(callback: FrameCallback): () => void {
    this.frameCallbacks.add(callback);
    return () => this.frameCallbacks.delete(callback);
  }

  start(): void {
    if (this.disposed) throw new Error('Engine: start() after dispose()');
    const now = performance.now();
    this.stats.since = now;
    this.quality.start(now);
    this.cleanup.add(() => this.renderer.setAnimationLoop(null));
    void this.renderer.setAnimationLoop((t) => this.frame(t));
    this.events.emit('engine:ready', {
      backend: this.backend,
      tier: this.quality.tier,
      gpuTiming: this.gpuTiming,
    });
    if (this.showStats) void this.loadStatsOverlay();
  }

  async dispose(): Promise<void> {
    this.frameCallbacks.clear();
    await this.cleanup.dispose();
  }

  private reportError(message: string, cause: unknown): void {
    if (!this.disposed) this.events.emit('engine:error', { message, cause });
  }

  private setupHood(d: TankDimensions): void {
    const hood = this.hood;
    hood.name = 'hood';
    hood.position.set(0.12, d.height + 1.2, 0.2);
    hood.target.position.set(0, d.height / 2, 0);
    this.medium.fixtureHeight.value = hood.position.y - this.medium.boxMax.value.y;
    this.scene.add(hood, hood.target);

    const shadowCam = hood.shadow.camera;
    const halfExtent = Math.max(d.length, d.depth) / 2 + 0.05;
    shadowCam.left = -halfExtent;
    shadowCam.right = halfExtent;
    shadowCam.top = halfExtent;
    shadowCam.bottom = -halfExtent;
    shadowCam.near = 0.2;
    shadowCam.far = d.height + 2;
    hood.shadow.bias = -0.0005;
    hood.shadow.normalBias = 0.01;

    hood.colorNode = this.caustics.lightColorNode();
    this.updateHoodUniforms();
  }

  private updateDaylight(nowMs: number): void {
    if (nowMs - this.daylightCheckedAt < DAYLIGHT_INTERVAL_MS) return;
    this.daylightCheckedAt = nowMs;
    const level = daylightAt(this.clock ?? minuteOfDay(new Date()));
    if (this.daylightAnnounced && Math.abs(level - this.daylightLevel) < DAYLIGHT_EPSILON) return;
    this.daylightAnnounced = true;
    this.daylightLevel = level;
    this.events.emit('engine:daylight', { level });
  }

  /**
   * The hood colour and intensity are the daytime setting (a preset may change them); the
   * photoperiod fades them into the moonlight channel and dims the room around the tank. The
   * room's level is in the environment node, so `scene.environmentIntensity` stays a plain gain.
   */
  private updateHoodUniforms(): void {
    const hood = this.hood;
    const day = this.daylightLevel;
    const casting = this.scratch.copy(hood.color).multiplyScalar(hood.intensity * day);
    const radiance = this.caustics.lightRadiance.value;
    radiance
      .copy(MOONLIGHT)
      .multiplyScalar(1 - day)
      .add(casting);
    this.caustics.lightDirection.value.copy(hood.position).sub(hood.target.position).normalize();
    this.caustics.updateContrast(casting, this.substrateAlbedo);
    const room = ROOM_AT_NIGHT + (1 - ROOM_AT_NIGHT) * day;
    this.interior.roomLevel.value = room;
    this.scene.backgroundIntensity = this.roomBackgroundIntensity * room;
    this.medium.hoodInScatter.value.copy(radiance).multiplyScalar(1 / (4 * Math.PI));
    this.medium.roomInScatter.value.copy(this.ambientScatter).multiplyScalar(room);
    this.interior.update();
  }

  private registerQualityFeatures(): void {
    this.quality.register('pixel-ratio', (s) => {
      this.renderer.setPixelRatio(renderPixelRatio(window.devicePixelRatio, s));
    });
    this.quality.register('shadows', (s) => {
      this.hood.castShadow = s.shadowMapSize > 0;
      if (s.shadowMapSize > 0) this.hood.shadow.mapSize.set(s.shadowMapSize, s.shadowMapSize);
    });
    this.quality.register('caustics', (s) => {
      this.caustics.setMethod(s.causticMethod, s.causticLayers);
    });
  }

  private async warmUp(): Promise<void> {
    this.updateDaylight(0);
    this.updateHoodUniforms();
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  /** The effects are a separate chunk; without them every tier still renders, just plainer. */
  private async loadEffects(): Promise<void> {
    try {
      const { Effects, postPipelineFactory } = await import('./effects');
      if (this.disposed) return;
      this.effects.attach(new Effects(this, postPipelineFactory(this.renderer)));
      this.cleanup.add(() => this.effects.dispose());
    } catch (cause) {
      this.reportError('Render effects failed to load; continuing without them', cause);
    }
  }

  private async loadStatsOverlay(): Promise<void> {
    try {
      const { createStatsOverlay } = await import('./statsOverlay');
      if (this.disposed) return;
      this.cleanup.add(createStatsOverlay(this, document.body));
    } catch (cause) {
      this.reportError('The ?stats=1 readout failed to load', cause);
    }
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private frame(nowMs: number): void {
    const frameMs = this.lastFrameAt === null ? 0 : nowMs - this.lastFrameAt;
    this.lastFrameAt = nowMs;
    const deltaS = Math.min(frameMs / 1000, MAX_DELTA_S);

    for (const callback of this.frameCallbacks) callback(deltaS, nowMs);
    this.updateDaylight(nowMs);
    this.updateHoodUniforms();
    if (this.cullPrewarm.begin(nowMs) > 0) this.sceneRevisionValue++;
    try {
      if (!this.effects.render()) this.renderer.render(this.scene, this.camera);
    } finally {
      this.cullPrewarm.end();
    }
    this.pollGpuTime();

    if (frameMs > 0) {
      this.quality.sample(frameMs, this.gpuMs, nowMs);
      this.gpuMs = null;
      this.stats.frames++;
      this.stats.frameMsSum += frameMs;
    }
    if (nowMs - this.stats.since >= STATS_INTERVAL_MS) this.emitStats(nowMs);
  }

  /** Timestamp queries resolve asynchronously; the result lands on a later frame. */
  private pollGpuTime(): void {
    if (this.gpuPending || !this.gpuTiming) return;
    this.gpuPending = true;
    this.renderer
      .resolveTimestampsAsync('render')
      .then((ms) => {
        if (typeof ms === 'number' && ms > 0) {
          this.gpuMs = ms;
          this.lastGpuMs = ms;
        }
      })
      .catch((cause: unknown) => {
        this.reportError('GPU timestamp query failed', cause);
      })
      .finally(() => {
        this.gpuPending = false;
      });
  }

  private emitStats(nowMs: number): void {
    const { frames, frameMsSum, since } = this.stats;
    const info = this.renderer.info.render;
    this.events.emit('engine:stats', {
      fps: (frames * 1000) / (nowMs - since),
      frameMs: frames > 0 ? frameMsSum / frames : 0,
      gpuMs: this.lastGpuMs,
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      tier: this.quality.tier,
    });
    this.stats = { frames: 0, frameMsSum: 0, since: nowMs };
  }
}
