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
import { installRoomLighting, DEFAULT_HDRI_URL, type RoomLighting } from './environment';
import { EventBus, type BackendKind, type EngineEvents, type EngineEventBus } from './events';
import type { EngineOptions } from './options';
import { QualityManager } from './quality/QualityManager';
import { DEFAULT_TANK, type TankDimensions, waterBounds } from './tank/dimensions';
import { Tank } from './tank/Tank';
import { Caustics } from './water/caustics';
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

function targetFrameMs(): number {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return 1000 / (coarse ? 30 : 60);
}

async function createRenderer(options: EngineOptions): Promise<{
  renderer: WebGPURenderer;
  backend: BackendKind;
}> {
  const renderer = new WebGPURenderer({
    forceWebGL: options.backend === 'webgl',
    antialias: window.devicePixelRatio < 2,
    trackTimestamp: true,
    powerPreference: 'high-performance',
  });
  await renderer.init();
  const backend: BackendKind = 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl2';
  if (options.backend === 'webgpu' && backend !== 'webgpu') {
    renderer.dispose();
    throw new Error('WebGPU was requested with ?backend=webgpu but is not available here');
  }
  renderer.toneMapping = AgXToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  return { renderer, backend };
}

export class Engine {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.05, 50);
  readonly medium: WaterMedium;
  readonly caustics: Caustics;
  readonly tank: Tank;
  readonly hood = new DirectionalLight(HOOD_COLOR, 3);
  /** Room light reaching the water from outside the hood, for in-scatter. */
  readonly ambientScatter = new Color(0.02, 0.03, 0.034);
  readonly quality: QualityManager;

  private readonly frameCallbacks = new Set<FrameCallback>();
  private readonly resizeObserver: ResizeObserver;
  private readonly roomLighting: RoomLighting;
  private lastFrameAt: number | null = null;
  private gpuMs: number | null = null;
  private readonly gpuTiming: boolean;
  private lastGpuMs: number | null = null;
  private gpuPending = false;
  private stats = { frames: 0, frameMsSum: 0, since: 0 };
  private disposed = false;

  static async create(container: HTMLElement, config: EngineConfig): Promise<Engine> {
    const events = config.events ?? new EventBus<EngineEvents>();
    try {
      const { renderer, backend } = await createRenderer(config.options);
      const engine = new Engine(container, renderer, backend, events, config);
      await engine.warmUp();
      return engine;
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
  ) {
    const dimensions = config.tank ?? DEFAULT_TANK;
    this.gpuTiming = renderer.hasFeature('timestamp-query');
    this.quality = new QualityManager(events, {
      pinned: config.options.tier,
      adaptive: config.options.adaptive,
      targetMs: targetFrameMs(),
    });

    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    this.medium = new WaterMedium(waterBounds(dimensions), config.water ?? DEFAULT_WATER);
    this.tank = new Tank(dimensions, this.medium);
    this.scene.add(this.tank.group);
    this.scene.fogNode = this.medium.fogNode();

    this.caustics = new Caustics(this.medium);
    this.caustics.bake(renderer);
    this.setupHood(dimensions);

    this.camera.position.set(0, 0.35, 1.6);
    this.camera.lookAt(0, 0.25, 0);

    this.roomLighting = installRoomLighting(
      renderer,
      this.scene,
      config.hdriUrl ?? DEFAULT_HDRI_URL,
      (message, cause) => events.emit('engine:error', { message, cause }),
    );

    this.registerQualityFeatures();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
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
    void this.renderer.setAnimationLoop((t) => this.frame(t));
    this.events.emit('engine:ready', {
      backend: this.backend,
      tier: this.quality.tier,
      gpuTiming: this.gpuTiming,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.frameCallbacks.clear();
    this.roomLighting.dispose();
    this.tank.dispose();
    this.caustics.dispose();
    this.hood.shadow.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private setupHood(d: TankDimensions): void {
    const hood = this.hood;
    hood.name = 'hood';
    hood.position.set(0.12, d.height + 1.2, 0.2);
    hood.target.position.set(0, d.height / 2, 0);
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

  private updateHoodUniforms(): void {
    const hood = this.hood;
    const radiance = this.caustics.lightRadiance.value;
    radiance.copy(hood.color).multiplyScalar(hood.intensity);
    this.caustics.lightDirection.value.copy(hood.position).sub(hood.target.position).normalize();
    this.medium.inScatterRadiance.value
      .copy(radiance)
      .multiplyScalar(1 / (4 * Math.PI))
      .add(this.ambientScatter);
  }

  private registerQualityFeatures(): void {
    this.quality.register('pixel-ratio', (s) => {
      this.renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, s.maxPixelRatio) * s.resolutionScale,
      );
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
    await this.renderer.compileAsync(this.scene, this.camera);
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
    this.updateHoodUniforms();
    this.renderer.render(this.scene, this.camera);
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
        this.events.emit('engine:error', { message: 'GPU timestamp query failed', cause });
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
