import type { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { mrt, vec4 } from 'three/tsl';
import type { QualityManager } from '../quality/QualityManager';
import type { TierSettings } from '../quality/tiers';
import type { Tank } from '../tank/Tank';
import type { Caustics } from '../water/caustics';
import type { WaterMedium } from '../water/medium';
import { createBubbles } from './bubbles';
import { createParticulates } from './particulates';
import { needsPost, PostPipeline, postSettingsKey, type PostSettings } from './post';
import { WaterShafts } from './shafts';
import type { SpriteEffect } from './sprites';

/** The parts of the engine the effects draw into. */
export interface EffectsHost {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly medium: WaterMedium;
  readonly caustics: Caustics;
  readonly tank: Tank;
  readonly quality: QualityManager;
}

/**
 * Tier-gated extras loaded after start-up as their own chunk: particulates, the bubble column and
 * the post pipeline (light shafts, bloom, depth of field, SMAA or TRAA).
 */
export class Effects {
  private readonly particulates: SpriteEffect;
  private readonly bubbles: SpriteEffect;
  private readonly shafts: WaterShafts;
  private post: PostPipeline | null = null;
  private postKey = '';
  private settings: Readonly<TierSettings> | null = null;
  private focus = false;
  private readonly unregister: () => void;

  constructor(private readonly host: EffectsHost) {
    const { medium, caustics, tank, scene, camera } = host;
    this.particulates = createParticulates(medium, caustics, tank.waterBounds);
    this.bubbles = createBubbles(medium, tank.waterBounds);
    this.shafts = new WaterShafts(camera, medium, caustics);
    scene.add(this.particulates.sprite, this.bubbles.sprite);
    this.unregister = host.quality.register('effects', (s) => this.apply(s));
  }

  setFocusMode(on: boolean): void {
    this.focus = on;
    if (this.settings !== null) this.configurePost(this.settings);
  }

  /** Renders the frame through the post pipeline; false when this tier draws straight to the canvas. */
  render(): boolean {
    if (this.post === null) return false;
    this.shafts.update();
    this.post.render();
    return true;
  }

  dispose(): void {
    this.unregister();
    this.post?.dispose();
    this.post = null;
    for (const { sprite, material } of [this.particulates, this.bubbles]) {
      sprite.removeFromParent();
      material.dispose();
    }
  }

  private apply(settings: Readonly<TierSettings>): void {
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
    this.postKey = key;
    this.post?.dispose();
    this.post =
      key === ''
        ? null
        : new PostPipeline(
            this.host.renderer,
            this.host.scene,
            this.host.camera,
            this.shafts,
            wanted,
          );
    this.setVelocityPassthrough(this.post?.temporal ?? false);
  }

  /** Additive sprites must add nothing to the velocity attachment TRAA reads. */
  private setVelocityPassthrough(on: boolean): void {
    this.host.tank.setVelocityPassthrough(on);
    for (const { material } of [this.particulates, this.bubbles]) {
      material.mrtNode = on ? mrt({ velocity: vec4(0) }) : null;
      material.needsUpdate = true;
    }
  }
}
