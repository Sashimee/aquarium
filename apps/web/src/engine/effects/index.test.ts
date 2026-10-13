import { describe, expect, it } from 'vitest';
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Box3,
  type ContextNode,
  LinearSRGBColorSpace,
  Lighting,
  type MRTNode,
  NoToneMapping,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  SRGBColorSpace,
  type ToneMapping,
  Vector3,
} from 'three/webgpu';
import { context, mrt, output } from 'three/tsl';
import { EffectsSlot } from '../effectsSlot';
import { EventBus, type EngineEvents } from '../events';
import { QualityManager } from '../quality/QualityManager';
import type { Tier } from '../quality/tiers';
import { Caustics } from '../water/caustics';
import { WaterMedium } from '../water/medium';
import { Effects, type Post, type PostFactory } from './index';
import type { PostSettings } from './post';
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
  const createPost: PostFactory = (_scene, _camera, _shafts, settings) => {
    if (failing !== null) throw failing;
    const post = new FakePost(settings, renderer);
    built.push(post);
    return post;
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
});
