import { Box3, Color, Vector3, type Node } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  exp,
  length,
  max,
  min,
  output,
  positionWorld,
  step,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * Representative wavelengths (nm) for the linear sRGB primaries, used to sample the
 * spectral absorption curves below.
 */
const PRIMARY_WAVELENGTHS = [610, 545, 465] as const;

/**
 * Pure-water absorption (1/m) at those wavelengths, interpolated from Pope & Fry (1997).
 * Red is lost first, so the blue-green cast grows with the light path.
 */
const PURE_WATER_ABSORPTION = [0.264, 0.055, 0.0105] as const;

/** Spectral slope (1/nm) of coloured dissolved organic matter ("tannins"). */
const CDOM_SLOPE = 0.014;

/**
 * Light hitting the water box but not an object inside it must not be attenuated
 * twice, so fragments farther than the far box face plus this tolerance are left to
 * the volume passes. It also covers the inner glass faces that sit just outside the
 * water box.
 */
const BOUNDARY_TOLERANCE = 0.005;

export interface WaterQuality {
  /** CDOM absorption at 440 nm (1/m): ~0 for reef water, 0.1-0.5 for tannin-stained water. */
  cdom440: number;
  /** Scattering coefficient (1/m) from suspended particles. */
  turbidity: number;
}

export function spectralAbsorption(cdom440: number): [number, number, number] {
  const [r, g, b] = PRIMARY_WAVELENGTHS.map(
    (lambda, i) =>
      (PURE_WATER_ABSORPTION[i] ?? 0) + cdom440 * Math.exp(-CDOM_SLOPE * (lambda - 440)),
  );
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error('spectralAbsorption: expected three primaries');
  }
  return [r, g, b];
}

/**
 * The participating medium inside the tank: spectral absorption plus single-scatter
 * in-scatter, evaluated along the view ray's segment inside the water box.
 */
export class WaterMedium {
  readonly boxMin = uniform(new Vector3());
  readonly boxMax = uniform(new Vector3());
  readonly absorption = uniform(new Vector3());
  readonly absorptionScale = uniform(1);
  readonly scattering = uniform(0.1);
  /** Radiance scattered towards the eye per unit of scattering, driven by the lights. */
  readonly inScatterRadiance = uniform(new Color(0.18, 0.22, 0.24));

  private quality: WaterQuality = { cdom440: 0, turbidity: 0.1 };

  constructor(bounds: Box3, quality: WaterQuality) {
    this.setBounds(bounds);
    this.setQuality(quality);
  }

  getQuality(): WaterQuality {
    return { ...this.quality };
  }

  setBounds(bounds: Box3): void {
    if (bounds.isEmpty()) throw new Error('WaterMedium: water bounds are empty');
    this.boxMin.value.copy(bounds.min);
    this.boxMax.value.copy(bounds.max);
  }

  setQuality(quality: WaterQuality): void {
    if (!(quality.cdom440 >= 0) || !(quality.turbidity >= 0)) {
      throw new RangeError('WaterMedium: cdom440 and turbidity must be >= 0');
    }
    this.quality = { ...quality };
    this.absorption.value.fromArray(spectralAbsorption(quality.cdom440));
    this.scattering.value = quality.turbidity;
  }

  extinction(): Node<'vec3'> {
    return this.absorption.mul(this.absorptionScale).add(this.scattering);
  }

  transmittance(pathLength: Node<'float'>): Node<'vec3'> {
    return exp(this.extinction().mul(pathLength).negate());
  }

  /** Light scattered into the view ray along a segment with transmittance `t`. */
  inScatter(t: Node<'vec3'>): Node<'vec3'> {
    const albedo = this.extinction().reciprocal().mul(this.scattering);
    return albedo.mul(this.inScatterRadiance).mul(t.oneMinus());
  }

  /**
   * Ray/box slab test from the camera to `target`. Returns the distance to the target
   * and the entry/exit distances of the water box along that ray.
   */
  raySegment(target: Node<'vec3'> = positionWorld) {
    const delta = target.sub(cameraPosition).toVar();
    const dist = length(delta).toVar();
    const dir = delta.div(max(dist, 1e-6));
    const invDir = step(vec3(0), dir)
      .mul(2)
      .sub(1)
      .div(max(abs(dir), 1e-6))
      .toVar();
    const t0 = this.boxMin.sub(cameraPosition).mul(invDir);
    const t1 = this.boxMax.sub(cameraPosition).mul(invDir);
    const tMin = min(t0, t1).toVar();
    const tMax = max(t0, t1).toVar();
    const tNear = max(max(tMin.x, tMin.y), tMin.z);
    const tFar = min(min(tMax.x, tMax.y), tMax.z).toVar();
    return { dist, tNear, tFar };
  }

  /** Length of the camera ray inside water up to the fragment, 0 if the fragment lies beyond the box. */
  pathToFragment(): Node<'float'> {
    const { dist, tNear, tFar } = this.raySegment();
    const inside = step(dist, tFar.add(BOUNDARY_TOLERANCE));
    return max(min(tFar, dist).sub(max(tNear, 0)), 0).mul(inside);
  }

  /** Length of the camera ray through the whole box, for fragments on its far faces. */
  pathThroughBox(): Node<'float'> {
    const { dist, tNear, tFar } = this.raySegment();
    return max(min(tFar, dist).sub(max(tNear, 0)), 0);
  }

  /** Scene fog node: attenuates and in-scatters the material output of anything in the water. */
  fogNode(): Node<'vec4'> {
    const t = this.transmittance(this.pathToFragment()).toVar();
    return vec4(output.rgb.mul(t).add(this.inScatter(t)), output.a);
  }

  /** For materials blending with premultiplied alpha (One, OneMinusSrcAlpha). */
  applyPremultiplied(color: Node<'vec4'>): Node<'vec4'> {
    const t = this.transmittance(this.pathToFragment()).toVar();
    return vec4(color.rgb.mul(t).add(this.inScatter(t).mul(color.a)), color.a);
  }

  /** Transmittance of the far-face volume pass. */
  volumeTransmittance(): Node<'vec3'> {
    return this.transmittance(this.pathThroughBox());
  }

  volumeInScatter(): Node<'vec3'> {
    return this.inScatter(this.transmittance(this.pathThroughBox()));
  }
}
