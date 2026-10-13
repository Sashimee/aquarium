import { describe, expect, it } from 'vitest';
import { Box3, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';
import { EventBus, type EngineEvents } from '../events';
import { QualityManager } from '../quality/QualityManager';
import type { Tier } from '../quality/tiers';
import { Caustics } from '../water/caustics';
import { WaterMedium } from '../water/medium';
import { Effects, type Post, type PostFactory } from './index';
import type { PostSettings } from './post';

class FakePost implements Post {
  readonly temporal: boolean;
  renders = 0;
  disposed = 0;

  constructor(readonly settings: PostSettings) {
    this.temporal = settings.chain === 'taa-bloom';
  }

  render(): void {
    this.renders += 1;
  }

  dispose(): void {
    this.disposed += 1;
  }
}

function setup(pinned: Tier) {
  const bounds = new Box3(new Vector3(-0.3, 0, -0.15), new Vector3(0.3, 0.35, 0.15));
  const medium = new WaterMedium(bounds, { cdom440: 0.1, turbidity: 0.1 });
  const scene = new Scene();
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
    const post = new FakePost(settings);
    built.push(post);
    return post;
  };
  const host = {
    scene,
    camera: new PerspectiveCamera(),
    medium,
    caustics: new Caustics(medium),
    tank: { waterBounds: bounds, setVelocityPassthrough: (on: boolean) => passthrough.push(on) },
    quality,
  };
  return {
    host,
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
    expect(effects.render()).toBe(true);
    expect(built[0]?.renders).toBe(1);
  });

  it('draws straight to the canvas on the low tier', () => {
    const { host, createPost, built } = setup('low');
    const effects = new Effects(host, createPost);
    expect(built).toHaveLength(0);
    expect(effects.render()).toBe(false);
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
    expect(effects.render()).toBe(true);
    expect(working?.renders).toBe(1);

    failWith(null);
    effects.setFocusMode(true);
    expect(working?.disposed).toBe(1);
    expect(built.at(-1)?.settings.depthOfField).toBe(true);
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
