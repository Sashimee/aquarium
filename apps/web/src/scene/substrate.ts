import { MeshStandardNodeMaterial, type Node, type Texture } from 'three/webgpu';
import {
  mix,
  mx_noise_float,
  normalMap,
  normalView,
  normalWorld,
  normalize,
  positionWorld,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { PresetSubstrate } from '@aquarium/shared';
import type { TankDimensions } from '../engine/tank/dimensions';

export interface SubstrateTextures {
  readonly baseColor: Texture;
  readonly normal: Texture;
  readonly arm: Texture;
}

export interface SubstrateLayers {
  readonly base: SubstrateTextures;
  readonly accent: SubstrateTextures | null;
}

/**
 * Textured substrate over the engine's heightfield: tiled PBR sand, with an optional second
 * material (pebbles) breaking through in drifts. Colour and roughness use world coordinates so
 * the cut faces behind the glass line up with the top; the normal map uses the top UVs.
 */
export function createSubstrateMaterial(
  layers: SubstrateLayers,
  options: Pick<PresetSubstrate, 'tint' | 'tileMeters'>,
  tank: TankDimensions,
): MeshStandardNodeMaterial {
  const tile = options.tileMeters;
  const top = positionWorld.xz.div(tile);
  const side = vec2(positionWorld.x.add(positionWorld.z), positionWorld.y).div(tile);
  const isTop = smoothstep(0.55, 0.85, normalWorld.y);
  const uvTop = uv().mul(
    vec2((tank.length - 2 * tank.glass) / tile, (tank.depth - 2 * tank.glass) / tile),
  );

  const sample = (set: SubstrateTextures) => {
    const colourTop = texture(set.baseColor, top).rgb;
    const colourSide = texture(set.baseColor, side).rgb;
    const armTop = texture(set.arm, top).rgb;
    const armSide = texture(set.arm, side).rgb;
    return {
      colour: mix(colourSide, colourTop, isTop),
      arm: mix(armSide, armTop, isTop),
      // @types/three types NormalMapNode without the node operator extensions.
      normal: normalMap(texture(set.normal, uvTop)) as unknown as Node<'vec3'>,
    };
  };

  const base = sample(layers.base);
  let colour: Node<'vec3'> = base.colour;
  let arm: Node<'vec3'> = base.arm;
  let normal: Node<'vec3'> = base.normal;

  if (layers.accent) {
    const accent = sample(layers.accent);
    const drift = mx_noise_float(positionWorld.mul(vec3(3.1, 0, 3.1)).add(7.3))
      .mul(0.5)
      .add(0.5)
      .add(positionWorld.x.mul(0.35))
      .sub(positionWorld.z.mul(0.55));
    const mask = smoothstep(0.62, 0.72, drift);
    colour = mix(colour, accent.colour, mask);
    arm = mix(arm, accent.arm, mask);
    normal = mix(normal, accent.normal, mask);
  }

  const material = new MeshStandardNodeMaterial({ metalness: 0 });
  material.name = 'substrate-textured';
  const [r, g, b] = options.tint;
  material.colorNode = colour.mul(vec3(r, g, b));
  material.aoNode = arm.r;
  material.roughnessNode = arm.g;
  material.normalNode = normalize(mix(normalView, normal, isTop));
  return material;
}
