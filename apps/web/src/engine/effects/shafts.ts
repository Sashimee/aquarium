import { Vector3, type Node, type PerspectiveCamera, type TextureNode } from 'three/webgpu';
import {
  dot,
  float,
  Fn,
  getViewPosition,
  If,
  interleavedGradientNoise,
  Loop,
  max,
  min,
  pow,
  screenCoordinate,
  uniform,
  uv,
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

  node(depth: TextureNode): Node<'vec3'> {
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
        const jitter = interleavedGradientNoise(screenCoordinate.xy);
        const sum = vec3(0).toVar();
        const mean = caustics.bakedMean().toVar();
        Loop(STEPS, ({ i }) => {
          const t = start.add(stepLength.mul(float(i).add(jitter)));
          const p = eye.add(dir.mul(t));
          const depth = max(medium.boxMax.y.sub(p.y), 0);
          const slant = depth.div(cosLight);
          const surface = p.xz.add(light.xz.mul(slant));
          const deviation = caustics.bakedAt(surface, SHAFT_PATTERN_SCALE, mean).sub(1);
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
      return shafts;
    })();
  }
}
