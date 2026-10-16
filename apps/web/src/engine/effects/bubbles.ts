import { AdditiveBlending, Sprite, SpriteNodeMaterial, Vector3, type Box3 } from 'three/webgpu';
import {
  cos,
  float,
  fract,
  hash,
  instanceIndex,
  length,
  max,
  sin,
  smoothstep,
  sqrt,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vertexStage,
} from 'three/tsl';
import type { WaterMedium } from '../water/medium';
import type { SpriteEffect } from './sprites';

const MIN_RADIUS_M = 0.0008;
const MAX_RADIUS_M = 0.0022;
/**
 * Terminal rise speed of millimetre air bubbles in water is ~0.2-0.3 m/s (Clift, Grace & Weber),
 * faster for larger ones up to ~2 mm.
 */
const MIN_RISE_M_PER_S = 0.2;
const MAX_RISE_M_PER_S = 0.3;
/** Zig-zag of a rising bubble from vortex shedding, with the plume widening as it climbs. */
const ZIGZAG_M = 0.0025;
const ZIGZAG_HZ = 4;
const PLUME_SPREAD = 0.06;
/** Surface tension holds a bubble at the surface for a moment before it bursts. */
const POP_ZONE_M = 0.004;
/** The airstone sits in the back left corner, slightly off the glass. */
const AIRSTONE_INSET_M = 0.06;
const AIRSTONE_HEIGHT_M = 0.03;

/**
 * An airstone's bubble column as one instanced sprite draw. A bubble is drawn as its bright rim
 * and the hood's highlight: the refraction through its body is too small to see at this size.
 */
export function createBubbles(medium: WaterMedium, bounds: Box3): SpriteEffect {
  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
  material.name = 'bubbles';
  material.blending = AdditiveBlending;
  material.fog = false;

  const source = uniform(
    new Vector3(
      bounds.min.x + AIRSTONE_INSET_M,
      bounds.min.y + AIRSTONE_HEIGHT_M,
      bounds.min.z + AIRSTONE_INSET_M,
    ),
  );
  const height = bounds.max.y - bounds.min.y - AIRSTONE_HEIGHT_M;

  const i = float(instanceIndex);
  const size = hash(i.add(0.17));
  const radius = float(MIN_RADIUS_M).add(size.mul(MAX_RADIUS_M - MIN_RADIUS_M));
  const rise = float(MIN_RISE_M_PER_S).add(size.mul(MAX_RISE_M_PER_S - MIN_RISE_M_PER_S));
  const climb = fract(time.mul(rise).div(height).add(hash(i))).toVar();
  const y = climb.mul(height);
  const heading = hash(i.add(0.61)).mul(Math.PI * 2);
  const spread = sqrt(climb)
    .mul(PLUME_SPREAD)
    .mul(hash(i.add(0.83)));
  const zigzag = sin(time.mul(ZIGZAG_HZ * Math.PI * 2).add(i)).mul(ZIGZAG_M);
  const offset = vec2(cos(heading), sin(heading)).mul(spread.add(zigzag));
  const centre = source.add(vec3(offset.x, y, offset.y)).toVar();
  material.positionNode = centre;

  const popping = smoothstep(height - POP_ZONE_M, height, y);
  material.scaleNode = radius.mul(2).mul(popping.mul(0.4).add(1));

  const light = medium.inScatterRadiance(medium.boxMax.y.sub(centre.y)).mul(4 * Math.PI);
  const toCamera = medium.transmittance(medium.pathToFragment(centre));
  const radiance = vertexStage(light.mul(toCamera).mul(popping.oneMinus()));
  const r = length(uv().sub(0.5)).mul(2);
  const rim = smoothstep(0.55, 0.9, r)
    .mul(smoothstep(0.9, 1, r).oneMinus())
    .mul(0.35);
  const highlight = smoothstep(0, 0.22, length(uv().sub(vec2(0.62, 0.68))))
    .oneMinus()
    .mul(0.6);
  material.colorNode = radiance.mul(max(rim, highlight));

  const sprite = new Sprite(material);
  sprite.name = 'bubbles';
  sprite.frustumCulled = false;
  sprite.renderOrder = 3;
  return { sprite, material };
}
