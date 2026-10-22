import { Vector3, type Node, type PerspectiveCamera, type TextureNode } from 'three/webgpu';
import {
  abs,
  dot,
  float,
  floor,
  Fn,
  fract,
  getViewPosition,
  If,
  int,
  interleavedGradientNoise,
  Loop,
  max,
  min,
  pow,
  screenCoordinate,
  textureSize,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Caustics } from '../water/caustics';
import type { WaterMedium } from '../water/medium';

const STEPS = 12;
/** Shafts are the caustic network seen side-on, so they are wider than it is up close. */
const SHAFT_PATTERN_SCALE = 0.45;
/** Henyey-Greenstein asymmetry for the shafts: forward scattering, so they glow towards the light. */
const PHASE_G = 0.6;
/**
 * Inverse-depth gap `|1 − here/tapDepth|` at which a low-resolution shaft texel counts half as much as
 * one on the same surface. A fish 1 cm off a plant 50 cm away is a 2% gap; fish against the back
 * glass are 20% or more, so their texels barely bleed onto each other.
 */
export const DEPTH_TOLERANCE = 0.01;

/**
 * How much a low-resolution shaft texel marched to view depth `tapDepth` counts towards a pixel at
 * view depth `here`, given its plain bilinear weight. The gap is taken in inverse depth, which is
 * affine across the screen on any plane: in view depth, the texel further along a surface seen at
 * a grazing angle is further off than the nearer one the same distance away on screen, so the
 * upscale leaned towards the nearer texel and smeared the shafts towards the camera.
 */
export function upscaleWeight(
  bilinear: Node<'float'>,
  tapDepth: Node<'float'>,
  here: Node<'float'>,
): Node<'float'> {
  const gap = abs(here.div(max(tapDepth, 1e-3)).oneMinus());
  return bilinear.div(gap.add(DEPTH_TOLERANCE));
}

/**
 * Light shafts under the surface, ray-marched through the water box behind each pixel up to the
 * scene depth. Only the caustic pattern's deviation from its mean is integrated: the uniform part
 * of the in-scatter is already in the fog, so this redistributes light into streaks.
 */
export class WaterShafts {
  readonly strength = uniform(5);
  private readonly eye = uniform(new Vector3());

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly medium: WaterMedium,
    private readonly caustics: Caustics,
  ) {}

  /** Call before rendering: the post quad has its own camera, so the scene's is passed in. */
  update(): void {
    this.camera.getWorldPosition(this.eye.value);
  }

  /**
   * The shafts in rgb and the view depth they were marched to in alpha, for `upscale` to tell
   * which low-resolution texels lie on the same surface as a full-resolution pixel.
   */
  node(depth: TextureNode): Node<'vec4'> {
    const { medium, caustics, camera, eye } = this;
    const projectionInverse = uniform(camera.projectionMatrixInverse);
    const cameraWorld = uniform(camera.matrixWorld);
    return Fn(() => {
      const coord = uv();
      const view = getViewPosition(coord, depth.sample(coord).r, projectionInverse);
      const world = cameraWorld.mul(vec4(view, 1)).xyz;
      const { dist, dir, tNear, tFar } = medium.raySegment(world, eye);
      const start = max(tNear, 0).toVar();
      const end = min(tFar, dist).toVar();
      const shafts = vec3(0).toVar();
      If(end.greaterThan(start), () => {
        const light = caustics.lightDirection;
        const cosLight = max(light.y, 0.2);
        const stepLength = end.sub(start).div(STEPS).toVar();
        const jitter = interleavedGradientNoise(screenCoordinate.xy).toVar();
        const sum = vec3(0).toVar();
        const mean = caustics.bakedMean().toVar();
        const drift = caustics.bakedDrift().toVar();
        Loop(STEPS, ({ i }) => {
          const t = start.add(stepLength.mul(float(i).add(jitter)));
          const p = eye.add(dir.mul(t));
          const depth = max(medium.boxMax.y.sub(p.y), 0);
          const slant = depth.div(cosLight);
          const surface = p.xz.add(light.xz.mul(slant));
          const deviation = caustics.bakedAt(surface, SHAFT_PATTERN_SCALE, mean, drift).sub(1);
          sum.addAssign(
            medium
              .transmittance(slant.add(t.sub(start)))
              .mul(medium.hoodSpread(depth))
              .mul(deviation),
          );
        });
        const g2 = PHASE_G * PHASE_G;
        const cosTheta = dot(dir, light.negate());
        const phase = float((1 - g2) / (4 * Math.PI)).div(
          pow(float(1 + g2).sub(cosTheta.mul(2 * PHASE_G)), 1.5),
        );
        shafts.assign(
          sum
            .mul(stepLength)
            .mul(medium.scattering)
            .mul(phase)
            .mul(caustics.lightRadiance)
            .mul(caustics.shaftContrast)
            .mul(this.strength),
        );
      });
      return vec4(shafts, view.z.negate());
    })();
  }

  /**
   * `rays` from `node`, at full resolution. Plain bilinear filtering spreads a background texel's
   * longer march across the edge of a fish in front of it, a pixel-wide glow; here each of the
   * four nearest texels also counts by how close its depth is to this pixel's.
   */
  upscale(rays: TextureNode, depth: TextureNode): Node<'vec3'> {
    const projectionInverse = uniform(this.camera.projectionMatrixInverse);
    return Fn(() => {
      const coord = uv();
      const here = getViewPosition(coord, depth.sample(coord).r, projectionInverse).z.negate();
      // @types/three types TextureSizeNode as an untyped Node; three builds it as a uvec2.
      const size = vec2(textureSize(rays, int(0)) as unknown as Node<'uvec2'>);
      const texel = coord.mul(size).sub(0.5);
      const base = floor(texel);
      const f = fract(texel);
      const sum = vec3(0).toVar();
      const total = float(0).toVar();
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const tap = rays.sample(base.add(vec2(dx + 0.5, dy + 0.5)).div(size));
        const bilinear = (dx === 0 ? f.x.oneMinus() : f.x).mul(dy === 0 ? f.y.oneMinus() : f.y);
        const weight = upscaleWeight(bilinear, tap.a, here).toVar();
        sum.addAssign(tap.rgb.mul(weight));
        total.addAssign(weight);
      }
      return sum.div(max(total, 1e-6));
    })();
  }
}
