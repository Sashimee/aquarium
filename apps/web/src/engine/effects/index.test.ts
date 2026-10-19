import { describe, expect, it, vi } from 'vitest';
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Box3,
  type ContextNode,
  LinearSRGBColorSpace,
  Lighting,
  MeshBasicNodeMaterial,
  type MRTNode,
  NoToneMapping,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  Sprite,
  SRGBColorSpace,
  type ToneMapping,
  Vector3,
} from 'three/webgpu';
import { context, mrt, output } from 'three/tsl';
import { EffectsSlot } from '../effectsSlot';
import { EventBus, type EngineEvents } from '../events';
import { PhotoLook } from '../photo/look';
import { materialIdOf } from '../pipelineErrors';
import { QualityManager } from '../quality/QualityManager';
import type { Tier } from '../quality/tiers';
import { Caustics } from '../water/caustics';
import { WaterMedium } from '../water/medium';
import { DEFAULT_TANK, TANK_DIMENSIONS, waterBounds } from '../tank/dimensions';
import { TIER_SETTINGS } from '../quality/tiers';
import { Effects, spriteShares, type Post, type PostFactory } from './index';
import {
  PostNodeLoader,
  postNodesFor,
  type PostNodeName,
  type PostNodes,
  type PostSettings,
} from './post';
import type { RenderStateTarget } from './renderState';

class FakeRenderer implements RenderStateTarget {
  target: RenderTarget | null = null;
  mrt: MRTNode | null = null;
  autoClear = true;
  autoClearColor = true;
  autoClearDepth = true;
  autoClearStencil = true;
  transparent = true;
  opaque = true;
  lighting = new Lighting();
  contextNode: ContextNode<unknown> = context();
  toneMapping: ToneMapping = AgXToneMapping;
  outputColorSpace: string = SRGBColorSpace;
  readonly xr = { enabled: false };
  renders = 0;
  renderError: Error | null = null;

  getRenderTarget(): RenderTarget | null {
    return this.target;
  }

  setRenderTarget(target: RenderTarget | null): void {
    this.target = target;
  }

  getMRT(): MRTNode | null {
    return this.mrt;
  }

  setMRT(mrt: MRTNode | null): void {
    this.mrt = mrt;
  }

  render(): void {
    this.renders += 1;
    if (this.renderError === null) return;
    this.scramble();
    throw this.renderError;
  }

  /** What a pass or post pipeline leaves behind when a node build throws part-way. */
  scramble(): void {
    this.setRenderTarget(new RenderTarget(4, 4));
    this.setMRT(mrt({ output }));
    this.autoClear = false;
    this.autoClearColor = false;
    this.autoClearDepth = false;
    this.autoClearStencil = false;
    this.transparent = false;
    this.opaque = false;
    this.lighting = new Lighting();
    this.contextNode = context();
    this.toneMapping = NoToneMapping;
    this.outputColorSpace = LinearSRGBColorSpace;
    this.xr.enabled = true;
  }

  snapshot() {
    const { target, mrt: m, lighting, contextNode, toneMapping, outputColorSpace } = this;
    const clears = [
      this.autoClear,
      this.autoClearColor,
      this.autoClearDepth,
      this.autoClearStencil,
    ];
    return {
      target,
      mrt: m,
      clears,
      passes: [this.transparent, this.opaque],
      lighting,
      contextNode,
      toneMapping,
      outputColorSpace,
      xr: this.xr.enabled,
    };
  }
}

class FakePost implements Post {
  readonly temporal: boolean;
  renders = 0;
  disposed = 0;
  renderError: Error | null = null;

  constructor(
    readonly settings: PostSettings,
    private readonly renderer: FakeRenderer,
  ) {
    this.temporal = settings.chain === 'taa-bloom';
  }

  render(): void {
    this.renders += 1;
    if (this.renderError === null) return;
    this.renderer.scramble();
    throw this.renderError;
  }

  dispose(): void {
    this.disposed += 1;
  }
}

/** Identity, not structure: a fresh Lighting or context node deep-equals the one it replaced. */
function expectRestored(renderer: FakeRenderer, before: ReturnType<FakeRenderer['snapshot']>) {
  const after = renderer.snapshot();
  expect(after.target).toBe(before.target);
  expect(after.mrt).toBe(before.mrt);
  expect(after.lighting).toBe(before.lighting);
  expect(after.contextNode).toBe(before.contextNode);
  expect(after).toEqual(before);
}

function setup(pinned: Tier) {
  const bounds = new Box3(new Vector3(-0.3, 0, -0.15), new Vector3(0.3, 0.35, 0.15));
  const medium = new WaterMedium(bounds, { cdom440: 0.1, turbidity: 0.1 });
  const scene = new Scene();
  const renderer = new FakeRenderer();
  const passthrough: boolean[] = [];
  const quality = new QualityManager(new EventBus<EngineEvents>(), {
    gpuTiming: false,
    pinned,
    adaptive: false,
    targetMs: 1000 / 60,
  });
  const built: FakePost[] = [];
  let failing: Error | null = null;
  let loaded = true;
  const loads: { settings: PostSettings; resolve: () => void; reject: (e: Error) => void }[] = [];
  const createPost: PostFactory = {
    ready: () => loaded,
    load: (settings) =>
      new Promise<void>((resolve, reject) => loads.push({ settings, resolve, reject })),
    create: (_scene, _camera, _shafts, settings) => {
      if (failing !== null) throw failing;
      const post = new FakePost(settings, renderer);
      built.push(post);
      return post;
    },
  };
  const host = {
    renderer,
    scene,
    camera: new PerspectiveCamera(),
    medium,
    caustics: new Caustics(medium),
    tank: { waterBounds: bounds, setVelocityPassthrough: (on: boolean) => passthrough.push(on) },
    quality,
  };
  return {
    host,
    renderer,
    scene,
    quality,
    built,
    passthrough,
    createPost,
    failWith(error: Error | null) {
      failing = error;
    },
    /** Post nodes arrive only when a test settles `loads`. */
    loadLazily() {
      loaded = false;
    },
    loads,
    async arrive(index: number) {
      loaded = true;
      loads[index]?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('Effects', () => {
  it('adds its sprites and builds the tier post pipeline', () => {
    const { host, createPost, scene, quality, built } = setup('high');
    const effects = new Effects(host, createPost);
    expect(scene.children.map((c) => c.name)).toEqual(['particulates', 'bubbles']);
    expect(quality.featureNames()).toEqual(['effects']);
    expect(built).toHaveLength(1);
    effects.render();
    expect(built[0]?.renders).toBe(1);
  });

  it('owns the materials of its sprites and nothing else in the scene', () => {
    const { host, createPost, scene } = setup('high');
    const effects = new Effects(host, createPost);
    const ids = scene.children.map((child) =>
      child instanceof Sprite ? materialIdOf(child.material) : null,
    );
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).not.toBeNull();
      expect(effects.ownsMaterial(id ?? -1)).toBe(true);
    }
    expect(effects.ownsMaterial(materialIdOf(new MeshBasicNodeMaterial()) ?? -1)).toBe(false);
  });

  it('draws the scene itself on the low tier, which has no post pipeline', () => {
    const { host, createPost, built, renderer } = setup('low');
    const effects = new Effects(host, createPost);
    effects.render();
    expect(built).toHaveLength(0);
    expect(renderer.renders).toBe(1);
  });

  it('restores the renderer state a failing post pipeline left behind', () => {
    const { host, createPost, built, renderer } = setup('ultra');
    renderer.toneMapping = ACESFilmicToneMapping;
    const before = renderer.snapshot();
    const effects = new Effects(host, createPost);
    const broken = new Error('traa node build failed');
    const post = built[0];
    if (post === undefined) throw new Error('ultra must build a post pipeline');
    post.renderError = broken;

    expect(() => effects.render()).toThrow(broken);
    expectRestored(renderer, before);
  });

  it('restores the renderer state when the plain scene render throws', () => {
    const { host, createPost, renderer } = setup('low');
    const before = renderer.snapshot();
    const effects = new Effects(host, createPost);
    renderer.renderError = new Error('sprite material build failed');
    expect(() => effects.render()).toThrow(/sprite material/);
    expectRestored(renderer, before);
  });

  it('removes the sprites before the engine falls back on the low tier', () => {
    const { host, createPost, renderer, scene, quality } = setup('low');
    const reports: unknown[] = [];
    const slot = new EffectsSlot((_message, cause) => reports.push(cause));
    slot.attach(new Effects(host, createPost));
    const broken = new Error('sprite material build failed');
    renderer.renderError = broken;

    expect(slot.render()).toBe(false);
    expect(scene.children).toEqual([]);
    expect(quality.featureNames()).toEqual([]);
    expect(reports).toEqual([broken]);
  });

  it('turns a failed tier change into a failure of the next frame', () => {
    const { host, createPost, quality, failWith } = setup('low');
    const effects = new Effects(host, createPost);
    const broken = new Error('bloom build failed');
    failWith(broken);

    expect(() => quality.setTier('high', 0)).not.toThrow();
    expect(() => effects.render()).toThrow(broken);
  });

  it('leaves nothing behind when the first tier setup throws', () => {
    const { host, createPost, scene, quality, failWith } = setup('high');
    const broken = new Error('post build failed');
    failWith(broken);
    expect(() => new Effects(host, createPost)).toThrow(broken);
    expect(scene.children).toEqual([]);
    expect(quality.featureNames()).toEqual([]);
  });

  it('keeps the working pipeline when building its replacement throws', () => {
    const { host, createPost, built, failWith } = setup('high');
    const effects = new Effects(host, createPost);
    const working = built[0];
    failWith(new Error('depth of field build failed'));

    expect(() => effects.setFocusMode(true)).toThrow(/depth of field/);
    expect(working?.disposed).toBe(0);
    effects.render();
    expect(working?.renders).toBe(1);

    failWith(null);
    effects.setFocusMode(true);
    expect(working?.disposed).toBe(1);
    expect(built.at(-1)?.settings.depthOfField).toBe(true);
  });

  it('keeps the focus mode across tier changes and has no depth of field on low', () => {
    const { host, createPost, built, quality } = setup('high');
    const effects = new Effects(host, createPost);
    effects.setFocusMode(true);
    expect(built.at(-1)?.settings.depthOfField).toBe(true);

    quality.setTier('low', 0);
    const lowBuilds = built.length;
    expect(built.at(-1)?.disposed).toBe(1);
    effects.setFocusMode(false);
    effects.setFocusMode(true);
    expect(built).toHaveLength(lowBuilds);

    quality.setTier('medium', 0);
    expect(built.at(-1)?.settings.depthOfField).toBe(true);
    effects.setFocusMode(false);
    expect(built.at(-1)?.settings.depthOfField).toBe(false);
  });

  it('lets photo mode decide depth of field over focus mode, and grades even on low', () => {
    const { host, createPost, built, quality, renderer } = setup('high');
    const effects = new Effects(host, createPost);
    const look = new PhotoLook();
    effects.setFocusMode(true);
    effects.setPhoto({ look, depthOfField: false, graded: true });
    expect(built.at(-1)?.settings).toMatchObject({ depthOfField: false, photo: look, grade: true });

    effects.setPhoto({ look, depthOfField: true, graded: true });
    expect(built.at(-1)?.settings).toMatchObject({ depthOfField: true, photo: look });

    quality.setTier('low', 0);
    expect(built.at(-1)?.settings).toMatchObject({
      chain: 'none',
      depthOfField: false,
      photo: look,
      grade: true,
    });
    const rendersBefore = renderer.renders;
    effects.render();
    expect(built.at(-1)?.renders).toBe(1);
    expect(renderer.renders).toBe(rendersBefore);

    const graded = built.length;
    effects.setPhoto(null);
    expect(built).toHaveLength(graded);
    expect(built.at(-1)?.disposed).toBe(1);
    effects.render();
    expect(renderer.renders).toBe(rendersBefore + 1);
  });

  it('draws the natural filter on low without a post pass', () => {
    const { host, createPost, built, renderer } = setup('low');
    const effects = new Effects(host, createPost);
    const before = built.length;
    effects.setPhoto({ look: new PhotoLook(), depthOfField: true, graded: false });
    expect(built).toHaveLength(before);
    const rendersBefore = renderer.renders;
    effects.render();
    expect(renderer.renders).toBe(rendersBefore + 1);
  });

  it('resolves temporally only while a TRAA pipeline is up and has not failed', () => {
    const { host, createPost, quality, failWith } = setup('ultra');
    const effects = new Effects(host, createPost);
    expect(effects.temporal).toBe(true);
    quality.setTier('high', 0);
    expect(effects.temporal).toBe(false);
    quality.setTier('ultra', 0);
    expect(effects.temporal).toBe(true);
    failWith(new Error('TRAA build failed'));
    quality.setTier('high', 0);
    quality.setTier('ultra', 0);
    expect(effects.temporal).toBe(false);
    effects.dispose();
  });

  it('turns velocity passthrough on only for a temporal pipeline, and off when disposed', () => {
    const { host, createPost, passthrough, scene, quality, built } = setup('ultra');
    const effects = new Effects(host, createPost);
    expect(passthrough).toEqual([true]);
    effects.dispose();
    expect(passthrough).toEqual([true, false]);
    expect(built[0]?.disposed).toBe(1);
    expect(scene.children).toEqual([]);
    expect(quality.featureNames()).toEqual([]);
  });

  it('draws plainly until the nodes of the tier pipeline arrive, then builds it', async () => {
    const { host, createPost, built, renderer, loads, loadLazily, arrive } = setup('high');
    loadLazily();
    const effects = new Effects(host, createPost);
    expect(built).toHaveLength(0);
    expect(loads.map((l) => l.settings.chain)).toEqual(['smaa-bloom']);
    effects.render();
    expect(renderer.renders).toBe(1);

    await arrive(0);
    expect(built.map((p) => p.settings.chain)).toEqual(['smaa-bloom']);
    effects.render();
    expect(built[0]?.renders).toBe(1);
    expect(renderer.renders).toBe(1);
  });

  it('keeps the current pipeline while the nodes of the next tier load', async () => {
    const { host, createPost, built, quality, loads, loadLazily, arrive } = setup('high');
    const effects = new Effects(host, createPost);
    const smaaBloom = built[0];
    loadLazily();
    quality.setTier('ultra', 0);
    expect(effects.temporal).toBe(false);
    effects.render();
    expect(smaaBloom?.renders).toBe(1);
    expect(smaaBloom?.disposed).toBe(0);

    await arrive(loads.length - 1);
    expect(smaaBloom?.disposed).toBe(1);
    expect(built.at(-1)?.settings.chain).toBe('taa-bloom');
    expect(effects.temporal).toBe(true);
  });

  it('builds only what is wanted when the nodes arrive, not what was asked first', async () => {
    const { host, createPost, built, quality, loadLazily, arrive } = setup('low');
    loadLazily();
    const effects = new Effects(host, createPost);
    quality.setTier('ultra', 0);
    quality.setTier('medium', 0);
    await arrive(0);
    await arrive(1);
    expect(built.map((p) => p.settings.chain)).toEqual(['smaa']);
    effects.dispose();
  });

  it('fails the next frame when the nodes cannot load', async () => {
    const { host, createPost, loads, loadLazily } = setup('high');
    loadLazily();
    const effects = new Effects(host, createPost);
    const offline = new Error('Failed to fetch dynamically imported module');
    loads[0]?.reject(offline);
    await Promise.resolve();
    await Promise.resolve();
    expect(() => effects.render()).toThrow(offline);
  });

  it('is ready at once when the tier pipeline needs no load', async () => {
    const { host, createPost, built } = setup('high');
    const effects = new Effects(host, createPost);
    await effects.ready();
    expect(built.map((p) => p.settings.chain)).toEqual(['smaa-bloom']);
  });

  it('is ready only once the lazily loaded tier pipeline is built', async () => {
    const { host, createPost, built, loadLazily, arrive } = setup('ultra');
    loadLazily();
    const effects = new Effects(host, createPost);
    let ready = false;
    const done = effects.ready().then(() => {
      ready = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(false);

    await arrive(0);
    await done;
    expect(built.map((p) => p.settings.chain)).toEqual(['taa-bloom']);
  });

  it('is ready when the nodes fail to load, leaving the failure to the next frame', async () => {
    const { host, createPost, loads, loadLazily } = setup('high');
    loadLazily();
    const effects = new Effects(host, createPost);
    const offline = new Error('Failed to fetch dynamically imported module');
    loads[0]?.reject(offline);
    await effects.ready();
    expect(() => effects.render()).toThrow(offline);
  });

  it('announces a pipeline that lands after the tier change, before the next frame', async () => {
    const { host, createPost, quality, loadLazily, arrive } = setup('high');
    const temporal: boolean[] = [];
    const slot = new EffectsSlot(
      () => undefined,
      (on) => temporal.push(on),
    );
    const effects = new Effects(host, createPost, () => slot.refresh());
    slot.attach(effects);
    loadLazily();
    quality.setTier('ultra', 0);
    slot.refresh();
    expect(temporal).toEqual([]);

    await arrive(0);
    expect(temporal).toEqual([true]);
    expect(slot.temporal).toBe(true);
  });

  it('ignores a failed load for a pipeline no longer wanted, and loads it again later', async () => {
    const { host, createPost, built, quality, loads, loadLazily, arrive } = setup('low');
    loadLazily();
    const changes: number[] = [];
    const effects = new Effects(host, createPost, () => changes.push(loads.length));
    quality.setTier('high', 0);
    quality.setTier('low', 0);
    loads[0]?.reject(new Error('offline'));
    await effects.ready();
    expect(() => effects.render()).not.toThrow();
    expect(changes).toEqual([]);

    quality.setTier('high', 0);
    expect(loads.map((l) => l.settings.chain)).toEqual(['smaa-bloom', 'smaa-bloom']);
    await arrive(1);
    expect(built.map((p) => p.settings.chain)).toEqual(['smaa-bloom']);
    effects.render();
    expect(built[0]?.renders).toBe(1);
  });

  it('builds nothing once disposed, however late the nodes arrive', async () => {
    const { host, createPost, built, loadLazily, arrive } = setup('ultra');
    loadLazily();
    const effects = new Effects(host, createPost);
    effects.dispose();
    await arrive(0);
    expect(built).toHaveLength(0);
  });

  it('thins the sprites for a smaller water box and follows it when it changes', () => {
    const { host, createPost, scene } = setup('ultra');
    host.tank.waterBounds.copy(waterBounds(DEFAULT_TANK));
    const effects = new Effects(host, createPost);
    const [particles, bubbles] = scene.children as Sprite[];
    expect(particles?.count).toBe(TIER_SETTINGS.ultra.particleCount);
    expect(bubbles?.count).toBe(TIER_SETTINGS.ultra.bubbleCount);

    waterBounds(TANK_DIMENSIONS.nano30, host.tank.waterBounds);
    effects.tankResized();
    const share = spriteShares(host.tank.waterBounds);
    expect(particles?.count).toBe(Math.round(TIER_SETTINGS.ultra.particleCount * share.particles));
    expect(bubbles?.count).toBe(Math.round(TIER_SETTINGS.ultra.bubbleCount * share.bubbles));
    expect(particles?.count).toBeLessThan(TIER_SETTINGS.ultra.particleCount / 5);
    expect(particles?.visible).toBe(true);
  });
});

describe('spriteShares', () => {
  it('is whole for the standard tank and never grows past the tier for a larger one', () => {
    expect(spriteShares(waterBounds(DEFAULT_TANK))).toEqual({ particles: 1, bubbles: 1 });
    const long = spriteShares(waterBounds(TANK_DIMENSIONS.long300));
    expect(long.particles).toBeLessThanOrEqual(1);
    expect(long.bubbles).toBeLessThan(1);
  });

  it('keeps the particle density by volume and the bubble column by height', () => {
    const standard = waterBounds(DEFAULT_TANK).getSize(new Vector3());
    const nano = waterBounds(TANK_DIMENSIONS.nano30).getSize(new Vector3());
    const share = spriteShares(waterBounds(TANK_DIMENSIONS.nano30));
    expect(share.particles).toBeCloseTo(
      (nano.x * nano.y * nano.z) / (standard.x * standard.y * standard.z),
      12,
    );
    expect(share.bubbles).toBeCloseTo(nano.y / standard.y, 12);
  });

  it('gives no sprites to an empty box', () => {
    expect(spriteShares(new Box3(new Vector3(), new Vector3()))).toEqual({
      particles: 0,
      bubbles: 0,
    });
  });
});

describe('PostNodeLoader', () => {
  function fakeImports() {
    const calls: PostNodeName[] = [];
    const node =
      <K extends PostNodeName>(name: K, fake: PostNodes[K]) =>
      (): Promise<PostNodes[K]> => {
        calls.push(name);
        return Promise.resolve(fake);
      };
    const imports = {
      bloom: node('bloom', vi.fn<PostNodes['bloom']>()),
      dof: node('dof', vi.fn<PostNodes['dof']>()),
      smaa: node('smaa', vi.fn<PostNodes['smaa']>()),
      traa: node('traa', vi.fn<PostNodes['traa']>()),
    };
    return { calls, imports };
  }

  it('needs only the nodes in the chain', () => {
    const plain = { godRays: true, depthOfField: false, photo: null, grade: false } as const;
    expect(postNodesFor({ ...plain, chain: 'none' })).toEqual([]);
    expect(postNodesFor({ ...plain, chain: 'smaa' })).toEqual(['smaa']);
    expect(postNodesFor({ ...plain, chain: 'smaa-bloom' })).toEqual(['bloom', 'smaa']);
    expect(
      postNodesFor({
        chain: 'taa-bloom',
        godRays: true,
        depthOfField: true,
        photo: null,
        grade: false,
      }),
    ).toEqual(['bloom', 'dof', 'traa']);
  });

  it('fetches each node once and is ready when all of a chain are in', async () => {
    const { calls, imports } = fakeImports();
    const nodes = new PostNodeLoader(imports);
    const smaa: PostSettings = {
      chain: 'smaa',
      godRays: false,
      depthOfField: false,
      photo: null,
      grade: false,
    };
    const bloom: PostSettings = {
      chain: 'smaa-bloom',
      godRays: false,
      depthOfField: false,
      photo: null,
      grade: false,
    };
    expect(nodes.ready(smaa)).toBe(false);
    expect(() => nodes.get('smaa')).toThrow(/not loaded/);

    await Promise.all([nodes.load(smaa), nodes.load(bloom)]);
    await nodes.load(bloom);
    expect(calls).toEqual(['smaa', 'bloom']);
    expect(nodes.ready(bloom)).toBe(true);
    expect(nodes.ready({ ...bloom, depthOfField: true })).toBe(false);
  });

  it('tries a node again after its chunk failed to load', async () => {
    let attempts = 0;
    const { imports } = fakeImports();
    const flaky = {
      ...imports,
      smaa: () => {
        attempts++;
        return attempts === 1 ? Promise.reject(new Error('offline')) : imports.smaa();
      },
    };
    const nodes = new PostNodeLoader(flaky);
    const smaa: PostSettings = {
      chain: 'smaa',
      godRays: false,
      depthOfField: false,
      photo: null,
      grade: false,
    };
    await expect(nodes.load(smaa)).rejects.toThrow('offline');
    expect(nodes.ready(smaa)).toBe(false);
    await nodes.load(smaa);
    expect(nodes.ready(smaa)).toBe(true);
  });
});
