import { Box3, Color, Vector3, type Node } from 'three/webgpu';
import { AIR_IOR, WATER_IOR } from './optics';
import {
  abs,
  cameraPosition,
  exp,
  length,
  max,
  min,
  mix,
  output,
  positionWorld,
  refract,
  sign,
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

/** Depth below which a point is in the water rather than on its surface. */
const SURFACE_MARGIN = 0.001;

/**
 * A hood about a metre above the surface: an extended LED array whose irradiance halves from the
 * surface to the sand of a 50 cm tank, as reef PAR maps show.
 */
const DEFAULT_FIXTURE_HEIGHT = 1.2;

/** Absorption scale and turbidity can both reach 0, which would make the albedo 0/0. */
const MIN_EXTINCTION = 1e-6;

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
  /** The hood's share of the radiance scattered towards the eye per unit of scattering, at the surface. */
  readonly hoodInScatter = uniform(new Color(0.18, 0.22, 0.24));
  /** The room's share, from light coming in through the glass: it does not fade with depth. */
  readonly roomInScatter = uniform(new Color(0.02, 0.03, 0.034));
  /** Height (m) of the hood's light source above the water surface, for its spread with depth. */
  readonly fixtureHeight = uniform(DEFAULT_FIXTURE_HEIGHT);

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

  /**
   * How much of the hood's surface irradiance its spread leaves at `depth` (m) below the surface,
   * as from a source `fixtureHeight` above it. Above the surface it is 1.
   */
  hoodSpread(depth: Node<'float'>): Node<'float'> {
    const h = this.fixtureHeight;
    return h.div(h.add(max(depth, 0))).pow(2);
  }

  /** The hood's light at `depth` below the surface relative to the surface: spread and absorption. */
  lightAtDepth(depth: Node<'float'>): Node<'vec3'> {
    return this.transmittance(max(depth, 0)).mul(this.hoodSpread(depth));
  }

  /**
   * Radiance per steradian reaching a point `depth` below the surface, as the hood's and the room's
   * light averaged over the sphere. Only the hood's part is dimmed and filtered on its way down;
   * without `depth` the surface level is used.
   */
  inScatterRadiance(depth?: Node<'float'>): Node<'vec3'> {
    const reaching = depth === undefined ? vec3(1) : this.lightAtDepth(depth);
    return reaching.mul(this.hoodInScatter).add(this.roomInScatter);
  }

  /** Light scattered into the view ray along a segment with transmittance `t` at mean `depth`. */
  inScatter(t: Node<'vec3'>, depth?: Node<'float'>): Node<'vec3'> {
    const albedo = max(this.extinction(), vec3(MIN_EXTINCTION)).reciprocal().mul(this.scattering);
    return albedo.mul(this.inScatterRadiance(depth)).mul(t.oneMinus());
  }

  /** `p` moved onto the nearest point inside the water box by at least `margin`. */
  clampInside(p: Node<'vec3'>, margin = 0.002): Node<'vec3'> {
    return min(max(p, this.boxMin.add(margin)), this.boxMax.sub(margin));
  }

  /**
   * 1 for points in the water, else 0. The box is widened at the glass so that the substrate's cut
   * faces against the panes count, and ends just under the surface so that the surface does not.
   */
  submerged(p: Node<'vec3'>): Node<'float'> {
    const below = vec3(BOUNDARY_TOLERANCE, -SURFACE_MARGIN, BOUNDARY_TOLERANCE);
    const inside = step(this.boxMin.sub(BOUNDARY_TOLERANCE), p).mul(
      step(p, this.boxMax.add(below)),
    );
    return inside.x.mul(inside.y).mul(inside.z);
  }

  /**
   * Ray/box slab test from the camera to `target`. Returns the distance to the target
   * and the entry/exit distances of the water box along that ray. Post-processing passes the
   * scene camera's position as `eye`, since `cameraPosition` there is the quad's camera.
   */
  raySegment(target: Node<'vec3'> = positionWorld, eye: Node<'vec3'> = cameraPosition) {
    const delta = target.sub(eye).toVar();
    const dist = length(delta).toVar();
    const dir = delta.div(max(dist, 1e-6)).toVar();
    const invDir = step(vec3(0), dir)
      .mul(2)
      .sub(1)
      .div(max(abs(dir), 1e-6))
      .toVar();
    const t0 = this.boxMin.sub(eye).mul(invDir);
    const t1 = this.boxMax.sub(eye).mul(invDir);
    const tMin = min(t0, t1).toVar();
    const tMax = max(t0, t1).toVar();
    const tNear = max(max(tMin.x, tMin.y), tMin.z);
    const tFar = min(min(tMax.x, tMax.y), tMax.z).toVar();
    return { dist, dir, tMin, tNear, tFar };
  }

  /**
   * The view ray's direction once it is in the water. From outside it is bent at the face it
   * entered through; the glass is a parallel plate, so only the air-water indices matter.
   */
  waterRayDirection(target: Node<'vec3'> = positionWorld): Node<'vec3'> {
    const { dir, tMin, tNear } = this.raySegment(target);
    const onX = step(max(tMin.y, tMin.z), tMin.x);
    const onY = step(max(tMin.x, tMin.z), tMin.y).mul(onX.oneMinus());
    const onZ = onX.oneMinus().mul(onY.oneMinus());
    const entryNormal = vec3(onX, onY, onZ).mul(sign(dir)).negate();
    const bent = refract(dir, entryNormal, AIR_IOR / WATER_IOR);
    return mix(bent, dir, step(tNear, 0));
  }

  /**
   * The camera ray's path inside water up to `target`, and the depth below the surface of that
   * path's midpoint. Unless `throughBox`, the path is 0 for targets beyond the box.
   */
  private segment(target: Node<'vec3'>, throughBox: boolean) {
    const { dist, dir, tNear, tFar } = this.raySegment(target);
    const start = max(tNear, 0).toVar();
    const end = min(tFar, dist).toVar();
    const length = max(end.sub(start), 0);
    const path = throughBox ? length : length.mul(step(dist, tFar.add(BOUNDARY_TOLERANCE)));
    const midY = cameraPosition.y.add(dir.y.mul(start.add(end).mul(0.5)));
    return { path, depth: this.boxMax.y.sub(midY) };
  }

  /** Length of the camera ray inside water up to `target`, 0 if the target lies beyond the box. */
  pathToFragment(target: Node<'vec3'> = positionWorld): Node<'float'> {
    return this.segment(target, false).path;
  }

  /** Distance from `origin` inside the water box to where a ray along `dir` leaves it. */
  exitDistance(origin: Node<'vec3'>, dir: Node<'vec3'>): Node<'float'> {
    const wall = mix(this.boxMin, this.boxMax, step(vec3(0), dir));
    const t = wall
      .sub(origin)
      .mul(sign(dir))
      .div(max(abs(dir), 1e-6));
    return max(min(min(t.x, t.y), t.z), 0);
  }

  /** Length of the camera ray through the whole box, for fragments on its far faces. */
  pathThroughBox(): Node<'float'> {
    return this.segment(positionWorld, true).path;
  }

  /** Scene fog node: attenuates and in-scatters the material output of anything in the water. */
  fogNode(): Node<'vec4'> {
    const { path, depth } = this.segment(positionWorld, false);
    const t = this.transmittance(path).toVar();
    return vec4(output.rgb.mul(t).add(this.inScatter(t, depth)), output.a);
  }

  /** For materials blending with premultiplied alpha (One, OneMinusSrcAlpha). */
  applyPremultiplied(color: Node<'vec4'>): Node<'vec4'> {
    const { path, depth } = this.segment(positionWorld, false);
    const t = this.transmittance(path).toVar();
    return vec4(color.rgb.mul(t).add(this.inScatter(t, depth).mul(color.a)), color.a);
  }

  /** Transmittance of the far-face volume pass. */
  volumeTransmittance(): Node<'vec3'> {
    return this.transmittance(this.pathThroughBox());
  }

  volumeInScatter(): Node<'vec3'> {
    const { path, depth } = this.segment(positionWorld, true);
    return this.inScatter(this.transmittance(path), depth);
  }
}
