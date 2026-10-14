import {
  BlendMode,
  MaterialBlending,
  NoBlending,
  RenderPipeline,
  type Material,
  type MRTNode,
  type Node,
  type PerspectiveCamera,
  type Scene,
  type TextureNode,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  float,
  Fn,
  max,
  min,
  mrt,
  output,
  pass,
  perspectiveDepthToViewZ,
  renderOutput,
  uniform,
  vec2,
  vec4,
  velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import type { PostChain } from '../quality/tiers';
import type { WaterShafts } from './shafts';

export interface PostSettings {
  readonly chain: PostChain;
  readonly godRays: boolean;
  /** Depth of field, only while the camera is in focus mode. */
  readonly depthOfField: boolean;
}

/** Highlights only: specular glints on scales and the water surface. */
const BLOOM = { strength: 0.12, radius: 0.35, threshold: 0.9 };
/** A macro lens on a fish 15-40 cm away: a shallow but not paper-thin focal zone. */
const DOF = { focalLength: 0.12, bokehScale: 2.5 };
/** Autofocus taps around the centre, in UV; the nearest wins so a small fish is not missed. */
const FOCUS_TAPS = [
  [0, 0],
  [0.03, 0],
  [-0.03, 0],
  [0, 0.04],
  [0, -0.04],
] as const;

export function postSettingsKey(settings: PostSettings): string {
  return `${settings.chain}|${settings.godRays}|${settings.depthOfField}`;
}

/** Whether a frame needs the post pipeline at all, or can go straight to the canvas. */
export function needsPost(settings: PostSettings): boolean {
  return settings.chain !== 'none' || settings.godRays || settings.depthOfField;
}

/**
 * Whether `material` blends into the velocity attachment. Such a material writes zero with zero
 * alpha there, which leaves the velocity the opaque scene wrote under normal, premultiplied,
 * additive and subtractive blending; a multiplying one must set its own (see `Tank`).
 */
export function blendsVelocity(material: Pick<Material, 'transparent' | 'blending'>): boolean {
  return material.transparent && material.blending !== NoBlending;
}

const sceneVelocity = Fn((builder) => {
  const { material } = builder;
  return material !== null && blendsVelocity(material) ? vec4(0) : velocity;
});

/**
 * The scene pass's attachments under TRAA. The velocity one blends as each material does, as on
 * WebGL without per-target blending or in WebGPU compatibility mode, so every backend keeps what
 * the opaque scene wrote under a blended material.
 */
export function temporalOutputs(): MRTNode {
  return mrt({ output, velocity: sceneVelocity() }).setBlendMode(
    'velocity',
    new BlendMode(MaterialBlending),
  );
}

interface Disposable {
  dispose(): void;
}

/**
 * Scene pass and screen-space effects for one tier. TRAA needs a velocity attachment and no MSAA;
 * the SMAA chains keep the renderer's MSAA in the scene pass and run SMAA after tone mapping.
 */
export class PostPipeline {
  readonly temporal: boolean;
  private readonly pipeline: RenderPipeline;
  private readonly owned: Disposable[] = [];

  constructor(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    shafts: WaterShafts,
    settings: PostSettings,
  ) {
    this.temporal = settings.chain === 'taa-bloom';
    this.pipeline = new RenderPipeline(renderer);
    try {
      this.pipeline.outputNode = this.build(scene, camera, shafts, settings);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  render(): void {
    this.pipeline.render();
  }

  dispose(): void {
    for (const node of this.owned.splice(0)) node.dispose();
    this.pipeline.dispose();
  }

  private build(
    scene: Scene,
    camera: PerspectiveCamera,
    shafts: WaterShafts,
    settings: PostSettings,
  ): Node {
    const { chain } = settings;
    const scenePass = pass(scene, camera, this.temporal ? { samples: 0 } : undefined);
    this.owned.push(scenePass);
    if (this.temporal) scenePass.setMRT(temporalOutputs());
    const depth = scenePass.getTextureNode('depth');

    let colour: Node<'vec4'> = scenePass.getTextureNode('output');
    if (settings.godRays) {
      colour = vec4(max(colour.rgb.add(shafts.node(depth)), 0), colour.a);
    }
    if (chain === 'smaa-bloom' || chain === 'taa-bloom') {
      const glow = bloom(colour, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
      this.owned.push(glow);
      colour = colour.add(glow);
    }
    let image: Node = colour;
    if (settings.depthOfField) {
      const blur = dof(
        colour,
        scenePass.getViewZNode(),
        autofocus(depth, camera),
        DOF.focalLength,
        DOF.bokehScale,
      );
      this.owned.push(blur);
      image = blur;
    }

    if (this.temporal) {
      const resolve = traa(image, depth, scenePass.getTextureNode('velocity'), camera);
      this.owned.push(resolve);
      return resolve;
    }
    if (chain === 'smaa' || chain === 'smaa-bloom') {
      const aa = smaa(renderOutput(image));
      this.owned.push(aa);
      this.pipeline.outputColorTransform = false;
      return aa;
    }
    return image;
  }
}

/** Distance along the view axis to the nearest surface around the screen centre. */
function autofocus(depth: TextureNode, camera: PerspectiveCamera): Node<'float'> {
  const near = uniform(camera.near);
  const far = uniform(camera.far);
  let nearest: Node<'float'> = float(camera.far);
  for (const [du, dv] of FOCUS_TAPS) {
    const d = depth.sample(vec2(0.5 + du, 0.5 + dv)).r;
    nearest = min(nearest, perspectiveDepthToViewZ(d, near, far).negate());
  }
  return nearest;
}
