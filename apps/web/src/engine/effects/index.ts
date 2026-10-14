import type { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { materialIdOf } from '../pipelineErrors';
import type { QualityManager } from '../quality/QualityManager';
import type { TierSettings } from '../quality/tiers';
import type { Tank } from '../tank/Tank';
import type { Caustics } from '../water/caustics';
import type { WaterMedium } from '../water/medium';
import { createBubbles } from './bubbles';
import { createParticulates } from './particulates';
import { needsPost, PostPipeline, postSettingsKey, type PostSettings } from './post';
import { captureRenderState, type RenderStateTarget } from './renderState';
import { WaterShafts } from './shafts';
import type { SpriteEffect } from './sprites';

/** The parts of the engine the effects draw into. */
export interface EffectsHost {
  readonly renderer: RenderStateTarget & Pick<WebGPURenderer, 'render'>;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly medium: WaterMedium;
  readonly caustics: Caustics;
  readonly tank: Pick<Tank, 'waterBounds' | 'setVelocityPassthrough'>;
  readonly quality: Pick<QualityManager, 'register'>;
}

/** A built post pipeline for one combination of settings. */
export interface Post {
  readonly temporal: boolean;
  render(): void;
  dispose(): void;
}

export type PostFactory = (
  scene: Scene,
  camera: PerspectiveCamera,
  shafts: WaterShafts,
  settings: PostSettings,
) => Post;

export function postPipelineFactory(renderer: WebGPURenderer): PostFactory {
  return (scene, camera, shafts, settings) =>
    new PostPipeline(renderer, scene, camera, shafts, settings);
}

/**
 * Tier-gated extras loaded after start-up as their own chunk: particulates, the bubble column and
 * the post pipeline (light shafts, bloom, depth of field, SMAA or TRAA).
 */
export class Effects {
  private readonly particulates: SpriteEffect;
  private readonly bubbles: SpriteEffect;
  private readonly shafts: WaterShafts;
  private post: Post | null = null;
  private postKey = '';
  private settings: Readonly<TierSettings> | null = null;
  private focus = false;
  /** A tier change that failed; thrown from the next frame so the engine drops the effects. */
  private failure: { cause: unknown } | null = null;
  private readonly unregister: () => void;

  constructor(
    private readonly host: EffectsHost,
    private readonly createPost: PostFactory,
  ) {
    const { medium, caustics, tank, scene, camera } = host;
    this.particulates = createParticulates(medium, caustics, tank.waterBounds);
    this.bubbles = createBubbles(medium, tank.waterBounds);
    this.shafts = new WaterShafts(camera, medium, caustics);
    scene.add(this.particulates.sprite, this.bubbles.sprite);
    try {
      this.unregister = host.quality.register('effects', (s) => this.apply(s));
    } catch (error) {
      this.disposeParts();
      throw error;
    }
  }

  /** Whether the frames drawn now go through a temporal resolve (TRAA). */
  get temporal(): boolean {
    return this.failure === null && (this.post?.temporal ?? false);
  }

  ownsMaterial(id: number): boolean {
    return [this.particulates, this.bubbles].some(({ material }) => materialIdOf(material) === id);
  }

  setFocusMode(on: boolean): void {
    this.focus = on;
    if (this.settings !== null) this.configurePost(this.settings);
  }

  /**
   * Draws the frame, through the post pipeline when the tier has one. The sprites are drawn here
   * too, so a failure in their materials reaches the caller instead of a later plain render.
   */
  render(): void {
    if (this.failure !== null) throw this.failure.cause;
    const { renderer, scene, camera } = this.host;
    const restore = captureRenderState(renderer, scene, camera);
    try {
      if (this.post === null) {
        renderer.render(scene, camera);
      } else {
        this.shafts.update();
        this.post.render();
      }
    } finally {
      restore();
    }
  }

  dispose(): void {
    this.unregister();
    this.disposeParts();
  }

  /** The first application throws to the constructor; later tier changes fail the next frame. */
  private apply(settings: Readonly<TierSettings>): void {
    if (this.settings === null) {
      this.applySettings(settings);
      return;
    }
    try {
      this.applySettings(settings);
    } catch (cause) {
      this.failure = { cause };
    }
  }

  private applySettings(settings: Readonly<TierSettings>): void {
    this.settings = settings;
    this.particulates.sprite.count = settings.particleCount;
    this.particulates.sprite.visible = settings.particleCount > 0;
    this.bubbles.sprite.count = settings.bubbleCount;
    this.bubbles.sprite.visible = settings.bubbleCount > 0;
    this.configurePost(settings);
  }

  private configurePost(settings: Readonly<TierSettings>): void {
    const wanted: PostSettings = {
      chain: settings.postChain,
      godRays: settings.godRays,
      depthOfField: settings.depthOfField && this.focus,
    };
    const key = needsPost(wanted) ? postSettingsKey(wanted) : '';
    if (key === this.postKey) return;
    const next =
      key === '' ? null : this.createPost(this.host.scene, this.host.camera, this.shafts, wanted);
    this.post?.dispose();
    this.post = next;
    this.postKey = key;
    this.host.tank.setVelocityPassthrough(next?.temporal ?? false);
  }

  private disposeParts(): void {
    const sprites = [this.particulates, this.bubbles];
    for (const { sprite } of sprites) sprite.removeFromParent();
    this.post?.dispose();
    this.post = null;
    this.host.tank.setVelocityPassthrough(false);
    for (const { material } of sprites) material.dispose();
  }
}
