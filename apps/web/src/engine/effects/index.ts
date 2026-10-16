import type { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import type { PhotoPost } from '../effectsSlot';
import { materialIdOf } from '../pipelineErrors';
import type { QualityManager } from '../quality/QualityManager';
import type { TierSettings } from '../quality/tiers';
import type { Tank } from '../tank/Tank';
import type { Caustics } from '../water/caustics';
import type { WaterMedium } from '../water/medium';
import { createBubbles } from './bubbles';
import { createParticulates } from './particulates';
import {
  needsPost,
  PostNodeLoader,
  PostPipeline,
  postSettingsKey,
  type PostSettings,
} from './post';
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

export interface PostFactory {
  /** Whether `create` can build `settings` now, without waiting for a chunk. */
  ready(settings: PostSettings): boolean;
  load(settings: PostSettings): Promise<void>;
  create(
    scene: Scene,
    camera: PerspectiveCamera,
    shafts: WaterShafts,
    settings: PostSettings,
  ): Post;
}

export function postPipelineFactory(renderer: WebGPURenderer): PostFactory {
  const nodes = new PostNodeLoader();
  return {
    ready: (settings) => nodes.ready(settings),
    load: (settings) => nodes.load(settings),
    create: (scene, camera, shafts, settings) =>
      new PostPipeline(renderer, nodes, scene, camera, shafts, settings),
  };
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
  private wanted: PostSettings | null = null;
  private settings: Readonly<TierSettings> | null = null;
  private focus = false;
  private photo: PhotoPost | null = null;
  private disposed = false;
  /** A tier change that failed; thrown from the next frame so the engine drops the effects. */
  private failure: { cause: unknown } | null = null;
  /** The node load in flight, settled only after its result is built or recorded. */
  private loading: Promise<void> | null = null;
  private readonly unregister: () => void;

  /** `changed` hears every pipeline swap or failure that lands outside a call into the effects. */
  constructor(
    private readonly host: EffectsHost,
    private readonly createPost: PostFactory,
    private readonly changed: () => void = () => undefined,
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

  /** Resolves once the wanted pipeline is built, has failed, or the effects are disposed. */
  async ready(): Promise<void> {
    while (this.loading !== null && !this.disposed) await this.loading;
  }

  ownsMaterial(id: number): boolean {
    return [this.particulates, this.bubbles].some(({ material }) => materialIdOf(material) === id);
  }

  setFocusMode(on: boolean): void {
    this.focus = on;
    if (this.settings !== null) this.configurePost(this.settings);
  }

  /** Photo mode's look, or null outside it; it overrides focus mode while set. */
  setPhoto(photo: PhotoPost | null): void {
    this.photo = photo;
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
    this.disposed = true;
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
    const { photo } = this;
    this.wanted = {
      chain: settings.postChain,
      godRays: settings.godRays,
      depthOfField: settings.depthOfField && (photo === null ? this.focus : photo.depthOfField),
      photo: photo?.look ?? null,
    };
    this.buildWanted();
  }

  private wantedKey(): string {
    const wanted = this.wanted;
    return wanted !== null && needsPost(wanted) ? postSettingsKey(wanted) : '';
  }

  /**
   * Until the nodes the wanted pipeline needs arrive, frames keep the pipeline they had. A failed
   * load only counts while its pipeline is still wanted; the loader forgets it, so the next request
   * for those nodes fetches them again.
   */
  private buildWanted(): void {
    const wanted = this.wanted;
    if (wanted === null) return;
    const key = this.wantedKey();
    if (key === this.postKey) return;
    if (key !== '' && !this.createPost.ready(wanted)) {
      const loading: Promise<void> = this.createPost
        .load(wanted)
        .then(
          () => {
            if (this.disposed) return;
            try {
              this.buildWanted();
            } catch (cause) {
              this.failure ??= { cause };
            }
            this.changed();
          },
          (cause: unknown) => {
            if (this.disposed || this.wantedKey() !== key) return;
            this.failure ??= { cause };
            this.changed();
          },
        )
        .finally(() => {
          if (this.loading === loading) this.loading = null;
        });
      this.loading = loading;
      return;
    }
    const next =
      key === ''
        ? null
        : this.createPost.create(this.host.scene, this.host.camera, this.shafts, wanted);
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
