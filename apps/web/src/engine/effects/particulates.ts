import { AdditiveBlending, Sprite, SpriteNodeMaterial, type Box3 } from 'three/webgpu';
import {
  cameraPosition,
  dot,
  float,
  fract,
  hash,
  instanceIndex,
  length,
  max,
  min,
  normalize,
  pow,
  sin,
  smoothstep,
  time,
  uv,
  vec3,
  vertexStage,
} from 'three/tsl';
import type { Caustics } from '../water/caustics';
import type { WaterMedium } from '../water/medium';
import type { SpriteEffect } from './sprites';

/** Detritus flakes and micro-bubbles: ~1-3 mm across, sinking a few mm per second. */
const MIN_SIZE_M = 0.0012;
const MAX_SIZE_M = 0.003;
const SINK_M_PER_S = 0.0025;
const DRIFT_M_PER_S = 0.004;
/** Henyey-Greenstein asymmetry of organic particles: strongly forward scattering. */
const PHASE_G = 0.75;
const BRIGHTNESS = 0.6;

/**
 * Particles suspended in the water, one instanced sprite draw. Each drifts on its own slow
 * current and wraps around the water box, fading out near the walls so the wrap never shows.
 * They are lit by the hood through the water, with a forward-scattering glint towards the light.
 */
export function createParticulates(
  medium: WaterMedium,
  caustics: Caustics,
  bounds: Box3,
): SpriteEffect {
  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
  material.name = 'particulates';
  material.blending = AdditiveBlending;
  material.fog = false;

  const i = float(instanceIndex);
  const seed = vec3(hash(i), hash(i.add(0.37)), hash(i.add(0.71)));
  const size = vec3(bounds.max).sub(vec3(bounds.min));
  const velocity = vec3(
    hash(i.add(0.13)).sub(0.5).mul(DRIFT_M_PER_S),
    hash(i.add(0.29)).mul(-SINK_M_PER_S),
    hash(i.add(0.53)).sub(0.5).mul(DRIFT_M_PER_S),
  );
  const wobble = sin(time.mul(0.6).add(seed.mul(40))).mul(0.002);
  const cell = fract(seed.add(velocity.mul(time).add(wobble).div(size))).toVar();
  const centre = vec3(bounds.min).add(cell.mul(size)).toVar();
  material.positionNode = centre;
  material.scaleNode = float(MIN_SIZE_M).add(hash(i.add(0.91)).mul(MAX_SIZE_M - MIN_SIZE_M));

  const margin = min(cell, cell.oneMinus()).mul(size);
  const inside = smoothstep(0, 0.02, min(min(margin.x, margin.y), margin.z));
  const toEye = normalize(cameraPosition.sub(centre));
  const cosTheta = dot(toEye, caustics.lightDirection.negate());
  const g2 = PHASE_G * PHASE_G;
  const phase = float(1 - g2).div(pow(float(1 + g2).sub(cosTheta.mul(2 * PHASE_G)), 1.5));
  const depth = medium.boxMax.y.sub(centre.y);
  const fromSurface = medium
    .transmittance(depth.div(max(caustics.lightDirection.y, 0.2)))
    .mul(medium.hoodSpread(depth));
  const toCamera = medium.transmittance(medium.pathToFragment(centre));
  const radiance = vertexStage(
    fromSurface
      .mul(toCamera)
      .mul(caustics.lightRadiance)
      .mul(phase.mul(inside).mul(BRIGHTNESS / (4 * Math.PI))),
  );
  const disc = smoothstep(0.15, 0.5, length(uv().sub(0.5))).oneMinus();
  material.colorNode = radiance.mul(disc);

  const sprite = new Sprite(material);
  sprite.name = 'particulates';
  sprite.frustumCulled = false;
  sprite.renderOrder = 3;
  return { sprite, material };
}
