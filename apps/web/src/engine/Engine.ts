import type { Biome, TankSize } from '@aquarium/shared';
import {
  AgXToneMapping,
  Color,
  DirectionalLight,
  PCFShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  type Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import {
  applyDayLighting,
  type DayLightingRig,
  FRESHWATER_FILL_LEVEL,
  lampGain,
} from './dayLighting';
import {
  DaylightFeed,
  DEFAULT_LAMP_SCHEDULE,
  daylightAt,
  lampPhotoperiod,
  localMinuteOfDay,
  minuteOfDay,
  type LampSchedule,
  type Photoperiod,
} from './daylight';
import { roomDaylightAt } from './room/timeOfDay';
import {
  browserSessionStore,
  type DeviceLossWatch,
  type DeviceLostInfo,
  type LossSource,
  respondToDeviceLoss,
  sessionBackend,
  watchDeviceLoss,
} from './deviceLoss';
import { showDeviceNotice } from './deviceNotice';
import {
  displayLimits,
  displayPreference,
  isTouchFirstDevice,
  type DisplayChoice,
  type DisplayLimits,
  type DisplayPreference,
} from './displayPreference';
import { EffectsRecovery, EffectsSlot } from './effectsSlot';
import { PipelineFailureHandler, usesMaterial, watchPipelineErrors } from './pipelineErrors';
import { installRoomLighting, DEFAULT_HDRI_URL } from './environment';
import { ASSET_BASE } from '../scene/assets';
import { createSharedKtx2, type Ktx2Textures } from './ktx2';
import { EventBus, type BackendKind, type EngineEvents, type EngineEventBus } from './events';
import { CullPrewarm } from './cullPrewarm';
import { ReflectedShadow } from './reflectedShadow';
import { TierShadow } from './tierShadow';
import { MaterialRebuild } from './materialRebuild';
import { deviceTextureLimit } from './photo/capture';
import { PhotoMode } from './photo/PhotoMode';
import { FrameCap } from './framePacing';
import { RenderLoop } from './renderLoop';
import { buildOrRelease, DisposeStack, settlesWithin } from './lifecycle';
import type { EngineOptions } from './options';
import { qualityProfile } from './quality/profile';
import { QualityManager } from './quality/QualityManager';
import { renderPixelRatio, type TierSettings } from './quality/tiers';
import { TankBackground } from './tank/background';
import {
  defaultView,
  TANK_DIMENSIONS,
  type TankDimensions,
  waterBounds,
  waterLitres,
} from './tank/dimensions';
import { meanSubstrateHeight } from './tank/substrate';
import { UNREFLECTED_LAYER } from './tank/surfaceReflection';
import { Tank } from './tank/Tank';
import { BIOME_WATER } from './water/biomeWater';
import { Caustics } from './water/caustics';
import { InteriorLight } from './water/interior';
import { WaterMedium, type WaterQuality } from './water/medium';

export type FrameCallback = (deltaS: number, nowMs: number) => void;

export interface EngineConfig {
  options: EngineOptions;
  events?: EngineEventBus;
  /** The player's frame rate and resolution opt-ins; the page-wide one by default. */
  display?: DisplayPreference;
  water?: WaterQuality;
  hdriUrl?: string;
}

const STATS_INTERVAL_MS = 500;
const DEFAULT_WATER: WaterQuality = BIOME_WATER.freshwater;
const MAX_DELTA_S = 0.1;
/** A stalled effects chunk never settles; past this the tank starts plain and they attach later. */
const EFFECTS_BOOT_WAIT_MS = 5000;
/** A capture waits this long for the look's pipeline before giving up rather than encode another. */
const CAPTURE_EFFECTS_WAIT_MS = 15000;

/** Hood LED, roughly 6500 K. */
const HOOD_COLOR = new Color(1, 0.97, 0.92);
/** At the water surface; the hood's spread leaves about three quarters of it on average below. */
const HOOD_INTENSITY = 4;

/** The part of the renderer the start-up path needs, so failures can be tested without a GPU. */
export interface StartableRenderer extends LossSource {
  init(): Promise<unknown>;
  dispose(): Promise<void> | void;
}

export type RendererFactory<R extends StartableRenderer> = (
  parameters: ConstructorParameters<typeof WebGPURenderer>[0],
) => R;

/**
 * Creates and initialises the renderer, registering its disposal on `cleanup` before
 * anything can fail, so a rejected init() or a refused backend still frees the device.
 * Device loss is watched from before init(), so a loss while the engine starts is not missed.
 */
export async function initRenderer<R extends StartableRenderer>(
  options: EngineOptions,
  cleanup: DisposeStack,
  create: RendererFactory<R>,
  devicePixelRatio: number,
): Promise<{ renderer: R; backend: BackendKind; deviceLoss: DeviceLossWatch }> {
  const renderer = create({
    forceWebGL: options.backend === 'webgl',
    antialias: devicePixelRatio < 2,
    trackTimestamp: true,
    powerPreference: 'high-performance',
  });
  cleanup.add(() => renderer.dispose());
  const deviceLoss = watchDeviceLoss(renderer);
  cleanup.add(() => deviceLoss.stop());
  await renderer.init();
  deviceLoss.watchDevice();
  const backend: BackendKind = 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl2';
  if (options.backend === 'webgpu' && backend !== 'webgpu') {
    throw new Error('WebGPU was requested with ?backend=webgpu but is not available here');
  }
  return { renderer, backend, deviceLoss };
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
  /** The picture behind the back glass; change it with `setBackground`. */
  readonly background: TankBackground;
  readonly hood = new DirectionalLight(HOOD_COLOR, HOOD_INTENSITY);
  /** Room light reaching the water from outside the hood, for in-scatter. */
  readonly ambientScatter = new Color(0.02, 0.03, 0.034);
  /** Linear albedo of the substrate, for the hood light it throws back: the dark freshwater sand. */
  readonly substrateAlbedo = new Color(0.13, 0.09, 0.055);
  readonly quality: QualityManager;
  /** The only KTX2 transcoder for this renderer; every texture loader shares it. */
  readonly ktx2: Ktx2Textures;
  readonly photo: PhotoMode;

  private size: TankSize;
  private readonly clock: number | null;
  private readonly showStats: boolean;
  private readonly daylightFeed: DaylightFeed;
  private photoperiod: Photoperiod = lampPhotoperiod(DEFAULT_LAMP_SCHEDULE);
  private readonly dayRig: DayLightingRig;
  private readonly effects = new EffectsSlot(
    (message, cause) => this.reportError(message, cause),
    (on) => this.events.emit('engine:temporal-resolve', { on }),
    (cause) => {
      if (!this.disposed) this.effectsRecovery.dropped(cause);
    },
  );
  private readonly effectsRecovery = new EffectsRecovery(
    () => {
      if (!this.disposed) this.effectsLoad = this.loadEffects();
    },
    (run, delayMs) => {
      const timer = window.setTimeout(run, delayMs);
      return () => window.clearTimeout(timer);
    },
  );
  private unregisterEffectsTemporal: (() => void) | null = null;
  private effectsCleanupAdded = false;
  private readonly frameCallbacks = new Set<FrameCallback>();
  private lastFrameAt: number | null = null;
  private readonly cullPrewarm = new CullPrewarm(this.scene);
  private readonly materialRebuild = new MaterialRebuild();
  private sceneRevisionValue = 0;
  /** Later tier changes warm what they turn on themselves. */
  private warmedUp = false;
  private readonly reflectedShadow = new ReflectedShadow();
  private readonly hoodShadow = new TierShadow(this.hood);
  private readonly loop: RenderLoop;
  private readonly frameCap: FrameCap;
  private displayLimits: DisplayLimits;
  private gpuMs: number | null = null;
  private readonly gpuTiming: boolean;
  private lastGpuMs: number | null = null;
  private gpuPending = false;
  private stats = { frames: 0, frameMsSum: 0, since: 0 };
  private effectsLoad: Promise<void> = Promise.resolve();
  /** A photo capture's oversized draws, which must not move the quality tier. */
  private skipFrameSample = false;
  private skipGpuSample = false;

  /** Everything is released through `cleanup`, both on dispose() and on a failed start. */
  static async create(container: HTMLElement, config: EngineConfig): Promise<Engine> {
    const events = config.events ?? new EventBus<EngineEvents>();
    try {
      return await buildOrRelease(
        async (cleanup) => {
          const session = sessionBackend(config.options.backend, browserSessionStore());
          const { renderer, backend, deviceLoss } = await initRenderer(
            { ...config.options, backend: session.backend },
            cleanup,
            (parameters) => new WebGPURenderer(parameters),
            window.devicePixelRatio,
          );
          configureRenderer(renderer);
          const engine = new Engine(
            container,
            renderer,
            backend,
            events,
            config,
            cleanup,
            deviceLoss,
          );
          if (session.fellBack) {
            cleanup.add(
              showDeviceNotice(
                document.body,
                'WebGPU stopped responding on this device, so this tab draws the tank with WebGL 2.',
              ),
            );
          }
          await engine.warmUp();
          engine.effectsLoad = engine.loadEffects();
          if (!(await settlesWithin(engine.effectsLoad, EFFECTS_BOOT_WAIT_MS))) {
            engine.reportError(
              'Render effects are slow to load; starting without them until they arrive',
              new Error(`effects not ready after ${EFFECTS_BOOT_WAIT_MS} ms`),
            );
          }
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
    deviceLoss: DeviceLossWatch,
  ) {
    const preference = config.options.backend;
    this.loop = new RenderLoop(renderer, (t) => this.frame(t));
    this.daylightFeed = new DaylightFeed(() => this.readDaylight(), events);
    deviceLoss.onLost((info) => this.deviceLost(info, preference));
    cleanup.add(() => this.effectsRecovery.dispose());
    this.size = config.options.tankSize;
    const dimensions = TANK_DIMENSIONS[this.size];
    this.clock = config.options.clock;
    this.showStats = config.options.stats;
    this.gpuTiming = renderer.hasFeature('timestamp-query');
    const profile = qualityProfile(isTouchFirstDevice());
    const display = config.display ?? displayPreference;
    const chosenDisplay = (): DisplayChoice => ({
      frameRate: config.options.frameRate ?? display.snapshot().frameRate,
      pixelRatio: config.options.pixelRatio ?? display.snapshot().pixelRatio,
    });
    this.displayLimits = displayLimits(profile, chosenDisplay());
    this.frameCap = new FrameCap(this.displayLimits.frameCapFps);
    cleanup.add(
      display.subscribe(() => {
        this.displayLimits = displayLimits(profile, chosenDisplay());
        this.frameCap.setFps(this.displayLimits.frameCapFps);
        this.applyPixelRatio();
      }),
    );
    this.quality = new QualityManager(events, {
      gpuTiming: this.gpuTiming && profile.gpuTiming,
      pinned: config.options.tier,
      adaptive: config.options.adaptive,
      targetMs: profile.targetMs,
      refreshMs: profile.refreshMs,
      probeTier: profile.probeTier,
      maxTier: profile.maxTier,
      maxTextureSize: profile.maxTextureSize,
      awaitContent: true,
    });
    const pipelineFailures = new PipelineFailureHandler(
      this.effects,
      (id) => usesMaterial(this.scene, id),
      (message, cause) => this.reportError(message, cause),
      () => this.materialRebuild.request(),
    );
    cleanup.add(watchPipelineErrors(renderer, (failure) => pipelineFailures.handle(failure)));

    container.appendChild(renderer.domElement);
    cleanup.add(() => renderer.domElement.remove());
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const sharedKtx2 = createSharedKtx2(renderer);
    cleanup.add(() => sharedKtx2.dispose());
    this.ktx2 = sharedKtx2.loader;

    const roomLighting = installRoomLighting(
      renderer,
      this.ktx2,
      this.scene,
      config.hdriUrl ?? DEFAULT_HDRI_URL,
      (message, cause) => this.reportError(message, cause),
    );
    cleanup.add(() => roomLighting.dispose());
    const roomBackgroundIntensity = this.scene.backgroundIntensity;

    this.medium = new WaterMedium(waterBounds(dimensions), config.water ?? DEFAULT_WATER);
    this.caustics = new Caustics(this.medium);
    cleanup.add(() => this.caustics.dispose());
    this.interior = new InteriorLight(
      this.medium,
      this.caustics,
      roomLighting.texture,
      this.substrateAlbedo,
      meanSubstrateHeight(dimensions),
    );
    this.interior.fillLevel = FRESHWATER_FILL_LEVEL;
    this.dayRig = {
      hood: this.hood,
      caustics: this.caustics,
      interior: this.interior,
      medium: this.medium,
      scene: this.scene,
      ambientScatter: this.ambientScatter,
      substrateAlbedo: this.substrateAlbedo,
      roomBackgroundIntensity,
      roomDaylight: 1,
      lampGain: lampGain(DEFAULT_LAMP_SCHEDULE.intensity),
    };
    this.background = new TankBackground(this.ktx2, this.quality.tier, ASSET_BASE);
    cleanup.add(() => this.background.dispose());
    this.tank = new Tank(
      dimensions,
      this.medium,
      roomLighting.texture,
      this.interior,
      this.background.map,
    );
    cleanup.add(() => this.tank.dispose());
    this.scene.add(this.tank.group);
    this.scene.fogNode = this.medium.fogNode();
    this.scene.environmentNode = this.interior.environmentNode();

    this.caustics.bake(renderer);
    this.setupHood();
    this.fitHood(dimensions);
    cleanup.add(() => this.hood.shadow.dispose());

    this.camera.layers.enable(UNREFLECTED_LAYER);
    this.frameTank(dimensions);

    this.photo = new PhotoMode({
      camera: this.camera,
      scene: this.scene,
      renderer,
      events,
      tank: () => this.tank.dimensions,
      depthOfFieldTier: () => this.quality.settings.depthOfField,
      temporal: () => this.effects.temporal,
      maxTextureSize: () => deviceTextureLimit(renderer.backend),
      setPost: (post) => this.effects.setPhoto(post),
      ready: () => this.effectsReady(),
      draw: () => this.draw(),
      captured: () => {
        this.skipFrameSample = true;
        this.skipGpuSample = true;
      },
    });
    cleanup.add(() => this.photo.dispose());

    this.registerQualityFeatures();
    cleanup.add(this.daylightFeed.watch(document));
    const followVisibility = (): void => this.loop.setHidden(document.hidden);
    followVisibility();
    document.addEventListener('visibilitychange', followVisibility);
    cleanup.add(() => document.removeEventListener('visibilitychange', followVisibility));

    const resizeObserver = new ResizeObserver(() => this.resize());
    cleanup.add(() => resizeObserver.disconnect());
    resizeObserver.observe(container);
    this.resize();
  }

  get tankSize(): TankSize {
    return this.size;
  }

  /** Litres of water in the tank as drawn, glass to waterline. */
  get waterLitres(): number {
    return waterLitres(this.tank.dimensions);
  }

  /**
   * Rebuilds the glass, water volume and sand for `size` and moves the water box every water
   * effect reads (fog, caustics, light shafts, particulates, bubbles) and the hood's shadow with
   * it, and frames the new tank unless photo mode holds the camera. No pipeline is rebuilt. Emits
   * `engine:tank-resized` when the size changed.
   */
  setTankSize(size: TankSize): void {
    if (size === this.size) return;
    const dimensions = TANK_DIMENSIONS[size];
    this.size = size;
    this.tank.resize(dimensions);
    this.medium.setBounds(this.tank.waterBounds);
    this.interior.sandHeight = meanSubstrateHeight(dimensions);
    this.fitHood(dimensions);
    if (!this.photo.active) this.frameTank(dimensions);
    this.effects.tankResized();
    this.sceneRevisionValue++;
    this.events.emit('engine:tank-resized', { size, dimensions, litres: this.waterLitres });
  }

  /** The room backdrop at full daylight; `scene.backgroundIntensity` is this times the room level. */
  get roomBackgroundIntensity(): number {
    return this.dayRig.roomBackgroundIntensity;
  }

  set roomBackgroundIntensity(value: number) {
    this.dayRig.roomBackgroundIntensity = value;
    applyDayLighting(this.dayRig, this.daylightFeed.level);
  }

  get disposed(): boolean {
    return this.cleanup.isDisposed;
  }

  /**
   * 0 = hood off (night, moonlight only) .. 1 = full day. It follows the tank's lamp schedule on
   * the sim's UTC clock, or `?clock=` read as a UTC time.
   */
  get daylight(): number {
    return this.daylightFeed.level;
  }

  /** Runs the visible hood on the tank's lamp schedule and strength, `equipment.light`. */
  setLampSchedule(schedule: LampSchedule): void {
    this.photoperiod = lampPhotoperiod(schedule);
    this.dayRig.lampGain = lampGain(schedule.intensity);
    this.daylightFeed.recheck();
  }

  /** Whether frames go through a temporal resolve; `engine:temporal-resolve` tells changes. */
  get temporalResolve(): boolean {
    return this.effects.temporal;
  }

  /** Where the scene is seen from this frame; LOD and audio should measure from here. */
  get viewPosition(): Vector3 {
    return this.photo.viewPosition;
  }

  /**
   * Shows the tank's background picture at the quality tier's size: `id` if it is one of
   * `biome`'s, else the biome's default. A failed load is reported on `engine:error` and leaves
   * the plain backdrop film.
   */
  setBackground(biome: Biome, id: string | null): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.background
      .show(biome, id)
      .catch((cause: unknown) => this.reportError('The tank background failed to load', cause));
  }

  /** Hands the background the scene's parsed `assets/index.json`; until then it shows the film. */
  useBackgroundIndex(json: unknown): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.background
      .useIndex(json)
      .catch((cause: unknown) => this.reportError('The tank background failed to load', cause));
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
    if (this.loop.start()) this.cleanup.add(() => this.loop.stop());
    this.events.emit('engine:ready', {
      backend: this.backend,
      tier: this.quality.tier,
      gpuTiming: this.gpuTiming,
    });
    if (this.showStats) void this.loadStatsOverlay();
  }

  /** The first scene and fish are drawn from the next frame on, so the quality probe may time them. */
  contentReady(): void {
    if (this.disposed) return;
    this.quality.contentReady(performance.now());
  }

  async dispose(): Promise<void> {
    this.frameCallbacks.clear();
    await this.cleanup.dispose();
  }

  private reportError(message: string, cause: unknown): void {
    if (!this.disposed) this.events.emit('engine:error', { message, cause });
  }

  /**
   * Every texture, pipeline and transcoded KTX2 format belongs to the lost device, and the fish,
   * scene and decor systems all hold them, so the WebGL 2 fallback is a fresh page load rather
   * than an in-place renderer swap.
   */
  private deviceLost(info: DeviceLostInfo, preference: EngineOptions['backend']): void {
    if (this.disposed) return;
    const removeNotice = respondToDeviceLoss(info, preference, {
      halt: () => this.loop.halt(),
      announce: (event) => this.events.emit('engine:device-lost', event),
      report: (message, cause) => this.reportError(message, cause),
      location: window.location,
      store: browserSessionStore(),
      notify: (message, action) => showDeviceNotice(document.body, message, action),
    });
    if (removeNotice !== null) this.cleanup.add(removeNotice);
  }

  private setupHood(): void {
    const hood = this.hood;
    hood.name = 'hood';
    this.scene.add(hood, hood.target);
    hood.shadow.camera.near = 0.2;
    hood.shadow.bias = -0.0005;
    hood.shadow.normalBias = 0.01;
    hood.colorNode = this.caustics.lightColorNode();
  }

  /** A camera rig that drives the camera every frame overrides this. */
  private frameTank(d: TankDimensions): void {
    const { eye, target } = defaultView(d);
    this.camera.position.copy(eye);
    this.camera.lookAt(target);
  }

  /** The hood hangs the same height over every tank; its shadow frustum covers the tank. */
  private fitHood(d: TankDimensions): void {
    const hood = this.hood;
    hood.position.set(0.12, d.height + 1.2, 0.2);
    hood.target.position.set(0, d.height / 2, 0);
    this.medium.fixtureHeight.value = hood.position.y - this.medium.boxMax.value.y;

    const shadowCam = hood.shadow.camera;
    const halfExtent = Math.max(d.length, d.depth) / 2 + 0.05;
    shadowCam.left = -halfExtent;
    shadowCam.right = halfExtent;
    shadowCam.top = halfExtent;
    shadowCam.bottom = -halfExtent;
    shadowCam.far = d.height + 2;
    shadowCam.updateProjectionMatrix();
    applyDayLighting(this.dayRig, this.daylightFeed.level);
  }

  /** The hood level now; the room light behind the tank follows on the same read. */
  private readDaylight(): number {
    this.dayRig.roomDaylight = roomDaylightAt(this.clock ?? minuteOfDay(new Date()));
    return daylightAt(this.clock ?? localMinuteOfDay(Date.now(), 0), this.photoperiod);
  }

  private registerQualityFeatures(): void {
    this.quality.register('pixel-ratio', (s) => this.applyPixelRatio(s));
    this.quality.register('shadows', (s) => this.hoodShadow.apply(s.shadowMapSize));
    this.quality.register('caustics', (s) => {
      // The context node's version is in every pipeline's cache key, so this rebuilds them all.
      if (this.caustics.setMethod(s.causticMethod, s.causticLayers)) {
        this.renderer.contextNode.needsUpdate = true;
      }
    });
    // A tier change can rebuild pipelines without touching a material, e.g. by toggling shadows.
    this.quality.register('cull-prewarm', () => this.cullPrewarm.invalidate());
    this.quality.register('background', (_, tier) => {
      this.background
        .setTier(tier)
        .catch((cause: unknown) =>
          this.reportError('The tank background failed to load at the new tier', cause),
        );
    });
    this.quality.register('surface-reflection', (s) => {
      const wasOn = this.tank.surfaceReflection;
      this.tank.setSurfaceReflection(s.surfaceReflection);
      if (wasOn || !this.tank.surfaceReflection || !this.warmedUp) return;
      this.tank
        .compileSurfaceReflection(this.renderer, this.scene, this.camera)
        .catch((cause: unknown) =>
          this.reportError('The surface reflection could not be prepared', cause),
        );
    });
  }

  private applyPixelRatio(settings: Readonly<TierSettings> = this.quality.settings): void {
    const ceiling = this.displayLimits.pixelRatioCeiling;
    this.renderer.setPixelRatio(renderPixelRatio(window.devicePixelRatio, settings, ceiling));
  }

  private async warmUp(): Promise<void> {
    this.daylightFeed.frame(0, 0);
    applyDayLighting(this.dayRig, this.daylightFeed.level);
    await this.renderer.compileAsync(this.scene, this.camera);
    await this.tank.compileSurfaceReflection(this.renderer, this.scene, this.camera);
    this.warmedUp = true;
  }

  /** The effects are a separate chunk; without them every tier still renders, just plainer. */
  private async loadEffects(): Promise<void> {
    try {
      const { Effects, postPipelineFactory } = await import('./effects');
      if (this.disposed) return;
      const effects = new Effects(this, postPipelineFactory(this.renderer), () =>
        this.effects.refresh(),
      );
      this.unregisterEffectsTemporal?.();
      this.unregisterEffectsTemporal = null;
      this.effects.attach(effects);
      if (!this.effectsCleanupAdded) {
        this.effectsCleanupAdded = true;
        this.cleanup.add(() => {
          this.unregisterEffectsTemporal?.();
          this.effects.dispose();
        });
      }
      // Right behind the effects' own feature, so the features registered later (the fish
      // materials) see the new tier's temporal resolve when its nodes are already loaded. A tier
      // whose nodes still have to load swaps its pipeline later; the refresh passed to `Effects`
      // then announces the change before the next frame, so the fish rebuild a second time but
      // never draw a temporal frame without velocity. The fish register only once
      // `Engine.create` resolves, which awaits this load unless it stalls; effects that attach
      // after the fish take that same announced path on every tier change.
      this.unregisterEffectsTemporal = this.quality.register('effects-temporal', () =>
        this.effects.refresh(),
      );
      // The first frames already carry the starting tier's look instead of popping into it.
      await effects.ready();
    } catch (cause) {
      this.reportError('Render effects failed to load; continuing without them', cause);
    }
  }

  private async effectsReady(): Promise<void> {
    const ready = this.effectsLoad.then(() => this.effects.ready());
    if (!(await settlesWithin(ready, CAPTURE_EFFECTS_WAIT_MS))) {
      throw new Error(
        `Render effects not ready after ${CAPTURE_EFFECTS_WAIT_MS} ms; try the capture again`,
      );
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
    const pacedMs = this.frameCap.tick(nowMs);
    if (pacedMs === null) return;
    const frameMs = this.lastFrameAt === null ? 0 : nowMs - this.lastFrameAt;
    this.lastFrameAt = nowMs;
    const deltaS = Math.min(frameMs / 1000, MAX_DELTA_S);

    // Before the callbacks so they see the photo camera, and after so a camera rig can't move it.
    this.photo.apply();
    for (const callback of this.frameCallbacks) callback(deltaS, nowMs);
    this.photo.apply();
    this.daylightFeed.frame(nowMs, frameMs);
    applyDayLighting(this.dayRig, this.daylightFeed.level);
    if (this.materialRebuild.flush(this.scene) > 0) this.cullPrewarm.invalidate();
    if (this.cullPrewarm.begin(nowMs) > 0) {
      this.sceneRevisionValue++;
      // Unculled first draws build pipelines, so this frame's timing is a compile stall.
      this.quality.stall(nowMs);
    }
    try {
      this.draw();
    } finally {
      this.cullPrewarm.end();
    }
    this.pollGpuTime();

    if (frameMs > 0) {
      if (this.skipFrameSample) this.skipFrameSample = false;
      else this.quality.sample(pacedMs, this.gpuMs, nowMs);
      this.gpuMs = null;
      this.stats.frames++;
      this.stats.frameMsSum += frameMs;
    }
    if (nowMs - this.stats.since >= STATS_INTERVAL_MS) this.emitStats(nowMs);
  }

  private draw(): void {
    this.renderSurfaceReflection();
    if (!this.effects.render()) this.renderer.render(this.scene, this.camera);
  }

  private renderSurfaceReflection(): void {
    this.reflectedShadow.draw(this.hood.shadow, this.hood.castShadow, () =>
      this.tank.renderSurfaceReflection(this.renderer, this.scene, this.camera),
    );
  }

  /** Timestamp queries resolve asynchronously; the result lands on a later frame. */
  private pollGpuTime(): void {
    if (this.gpuPending || !this.gpuTiming) return;
    this.gpuPending = true;
    // Queries pile up until resolved, so the first resolve begun after a capture holds its draws.
    const skip = this.skipGpuSample;
    this.skipGpuSample = false;
    this.renderer
      .resolveTimestampsAsync('render')
      .then((ms) => {
        if (!skip && typeof ms === 'number' && ms > 0) {
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
