import {
  Color,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  RepeatWrapping,
  Vector3,
  type Node,
  type Renderer,
} from 'three/webgpu';
import {
  dot,
  exp,
  float,
  floor,
  fract,
  Fn,
  If,
  length,
  max,
  min,
  mix,
  mod,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { CausticMethod } from '../quality/tiers';
import { lattice, PATTERN, PATTERN_GAIN, tiledFrequency } from './causticPattern';
import type { WaterMedium } from './medium';

const TAU = Math.PI * 2;
const BAKE_PERIOD_CELLS = 10;
const BAKE_SIZE = 512;
/** The floor is seen at a grazing angle; isotropic mips would blur the filaments away along it. */
const BAKE_ANISOTROPY = 8;
const DISPERSION = 0.015;
/** Floor on the light's elevation cosine, so a grazing hood does not stretch the slant path without bound. */
const MIN_COS_LIGHT = 0.2;
/** The whole net slides slowly with the surface current, in cells per unit of animation time. */
const DRIFT = [0.17, 0.1] as const;
/** The low tier's second sample of the baked tile is turned and scaled so the two never line up. */
const BAKED_TURN = 0.61;
const BAKED_SCALE = 0.73;
/**
 * The low tier sees the tile minified, at a grazing angle across the floor, where the thinnest
 * filaments would average away in its mips: it bakes them no sharper than half-focused.
 */
const BAKED_FOCUS = 0.5;
/** Mip bias of the baked tile: a little sharper than trilinear, softer where the light is defocused. */
const BAKED_BIAS = -0.5;
const BAKED_DEFOCUS_BLUR = 1.2;
/** Default contrast of the net: a multi-LED hood, whose emitters' nets partly fill each other in. */
const BASE_STRENGTH = 0.7;
/** Luminance of the dark freshwater sand, the substrate `BASE_STRENGTH` is set for. */
const REFERENCE_SUBSTRATE_LUMINANCE = 0.12;

const METHOD_ID = { texture: 0, single: 1, layered: 2, dispersion: 3 } as const;

const hash12 = (p: Node<'vec2'>): Node<'float'> =>
  fract(sin(dot(p, vec2(419.2, 371.9))).mul(43758.5453));

const hash22 = (p: Node<'vec2'>): Node<'vec2'> =>
  fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))).mul(43758.5453));

const wrapCell = (id: Node<'vec2'>, period: number | null): Node<'vec2'> =>
  period === null ? id : mod(id, period);

function valueNoise(p: Node<'vec2'>, period: number | null): Node<'float'> {
  const cell = floor(p).toVar();
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3)).toVar();
  const corner = (i: number, j: number): Node<'float'> =>
    hash12(wrapCell(cell.add(vec2(i, j)), period));
  return mix(mix(corner(0, 0), corner(1, 0), u.x), mix(corner(0, 1), corner(1, 1), u.x), u.y);
}

/**
 * Animated Voronoi F2-F1 distance: zero on cell borders, where refracted rays from a
 * rippled surface converge into the bright caustic network. With `period` set, cell ids
 * wrap so the pattern tiles.
 */
function cellEdge(p: Node<'vec2'>, t: Node<'float'>, period: number | null): Node<'float'> {
  const cell = floor(p).toVar();
  const f = fract(p).toVar();
  const f1 = float(8).toVar();
  const f2 = float(8).toVar();
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const offset = vec2(i, j);
      const h = hash22(wrapCell(cell.add(offset), period));
      const wander = vec2(sin(t.add(h.x.mul(TAU))), sin(t.mul(1.13).add(h.y.mul(TAU))));
      const feature = offset.add(0.5).add(wander.mul(PATTERN.featureWander));
      const d = length(feature.sub(f)).toVar();
      f2.assign(min(f2, max(f1, d)));
      f1.assign(min(f1, d));
    }
  }
  return f2.sub(f1);
}

/** Bends the straight Voronoi borders into the curved filaments a rippled surface draws. */
function warp(q: Node<'vec2'>, t: Node<'float'>, period: number | null): Node<'vec2'> {
  const [a, b] = PATTERN.warpWaves;
  const wave = (k: readonly [number, number], rate: number): Node<'float'> =>
    sin(dot(q, vec2(tiledFrequency(k[0], period), tiledFrequency(k[1], period))).add(t.mul(rate)));
  return q.add(
    vec2(wave(a, PATTERN.warpRates[0]), wave(b, PATTERN.warpRates[1])).mul(PATTERN.warpAmplitude),
  );
}

/** Where the large, slow swell of the surface focuses the light (1) or spreads it (0). */
function focusField(q: Node<'vec2'>, t: Node<'float'>, period: number | null): Node<'float'> {
  const drift = t.mul(PATTERN.focusRate);
  let sum: Node<'float'> = float(0);
  PATTERN.focusOctaves.forEach((octave, k) => {
    const grid = lattice(octave.scale, period);
    const p = q.mul(grid.scale).add(vec2(drift.mul(k + 1), drift.mul(-0.6)));
    sum = sum.add(valueNoise(p, grid.period).mul(octave.weight));
  });
  return smoothstep(PATTERN.focusEdges[0], PATTERN.focusEdges[1], sum);
}

function breakup(q: Node<'vec2'>, t: Node<'float'>, period: number | null): Node<'float'> {
  const grid = lattice(PATTERN.breakupScale, period);
  const p = q.mul(grid.scale).add(vec2(PATTERN.breakupDrift[0], PATTERN.breakupDrift[1]).mul(t));
  const fade = smoothstep(
    PATTERN.breakupEdges[0],
    PATTERN.breakupEdges[1],
    valueNoise(p, grid.period),
  );
  return mix(PATTERN.breakupFloor, 1, fade);
}

/** Narrow, bright filaments where focused, wide, dim ones where not, with the same light in each. */
function filament(edge: Node<'float'>, focus: Node<'float'>): Node<'float'> {
  const width = mix(PATTERN.defocusedWidth, PATTERN.focusedWidth, focus).toVar();
  const profile = pow(saturate(edge.div(width).oneMinus()), PATTERN.edgePower);
  return profile.mul(PATTERN.focusedWidth).div(width);
}

function net(
  q: Node<'vec2'>,
  t: Node<'float'>,
  focus: Node<'float'>,
  period: number | null,
): Node<'float'> {
  return filament(cellEdge(warp(q, t, period), t, period), focus).mul(breakup(q, t, period));
}

const layeredPattern = (q: Node<'vec2'>, t: Node<'float'>, focus: Node<'float'>): Node<'float'> => {
  const near = net(q, t, focus, null);
  const fineQ = q.mul(PATTERN.fineScale).add(vec2(PATTERN.fineOffset[0], PATTERN.fineOffset[1]));
  const far = net(fineQ, t.mul(PATTERN.fineRate), focus, null);
  return near.mul(PATTERN.layerWeights[0]).add(far.mul(PATTERN.layerWeights[1]));
};

export function causticMethodId(method: CausticMethod, layers: 1 | 2): number {
  if (method === 'texture') return METHOD_ID.texture;
  if (method === 'procedural-dispersion') return METHOD_ID.dispersion;
  return layers === 2 ? METHOD_ID.layered : METHOD_ID.single;
}

const luminance = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Share of the hood's light that casts caustics. Only its main channel does: the moonlight channel
 * is a row of small, dim LEDs spread along the fixture, which seen from the floor is a source far
 * wider than the angle a ripple focuses over, so its nets smear into an even glow; and at its
 * level, a few per cent of the day, a filament would sit below what the eye resolves anyway. So
 * the share is exactly zero with the main channel off.
 */
export function castingShare(castingLuminance: number, totalLuminance: number): number {
  if (!(totalLuminance > 0) || !(castingLuminance > 0)) return 0;
  return Math.min(castingLuminance / totalLuminance, 1);
}

/**
 * How far the caustics swing the light about its mean on a surface.
 *
 * The frame has one exposure, where an eye looking at white sand adapts to it. With perceived
 * brightness going as the square root of luminance (Stevens), a filament's perceived step is
 * about half the contrast times the square root of the floor's luminance; holding that at the
 * dark sand's level scales the contrast by the square root of the luminance ratio.
 */
export function causticContrast(
  strength: number,
  share: number,
  substrateLuminance: number,
): number {
  const substrate = Math.sqrt(REFERENCE_SUBSTRATE_LUMINANCE / Math.max(substrateLuminance, 1e-4));
  return strength * share * Math.min(substrate, 1);
}

/**
 * Caustics projected from the water surface along the hood light's direction. They are
 * applied as the light's colour node, so every lit surface under water (substrate, decor,
 * fish) receives them, and the light's shadow map masks them.
 */
export class Caustics {
  /** The net's contrast in full daylight on dark sand; `contrast` is what the surfaces get. */
  readonly strength = uniform(BASE_STRENGTH);
  readonly contrast = uniform(0);
  /** See `castingShare`. */
  readonly castingShare = uniform(0);
  readonly cellsPerMetre = uniform(13);
  readonly speed = uniform(0.55);
  readonly method = uniform(METHOD_ID.layered, 'int');
  /** Unit vector from the scene towards the light. */
  readonly lightDirection = uniform(new Vector3(0, 1, 0));
  readonly lightRadiance = uniform(new Color(1, 1, 1));

  private readonly bakeTarget = new RenderTarget(BAKE_SIZE, BAKE_SIZE, {
    type: HalfFloatType,
    generateMipmaps: true,
    anisotropy: BAKE_ANISOTROPY,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    depthBuffer: false,
  });
  private baked = false;

  constructor(private readonly medium: WaterMedium) {}

  setMethod(method: CausticMethod, layers: 1 | 2): void {
    if (method === 'texture' && !this.baked) {
      throw new Error('Caustics: call bake() before selecting the texture method');
    }
    this.method.value = causticMethodId(method, layers);
  }

  /**
   * Call once per frame, after `lightRadiance` is set: `casting` is the part of it from the hood
   * channel that casts caustics.
   */
  updateContrast(casting: Color, substrateAlbedo: Color): void {
    const share = castingShare(luminance(casting), luminance(this.lightRadiance.value));
    this.castingShare.value = share;
    this.contrast.value = causticContrast(this.strength.value, share, luminance(substrateAlbedo));
  }

  /** Renders one tileable frame of the procedural pattern for the low tier. */
  bake(renderer: Renderer): void {
    const material = new NodeMaterial();
    material.fragmentNode = Fn(() => {
      const q = uv().mul(BAKE_PERIOD_CELLS).toVar();
      const t = float(0);
      const focus = focusField(q, t, BAKE_PERIOD_CELLS);
      return vec4(vec3(net(q, t, focus.mul(BAKED_FOCUS), BAKE_PERIOD_CELLS)), 1);
    })();
    const quad = new QuadMesh(material);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.bakeTarget);
    quad.render(renderer);
    renderer.setRenderTarget(previous);
    material.dispose();
    this.baked = true;
  }

  dispose(): void {
    this.bakeTarget.dispose();
  }

  /**
   * The baked pattern with unit mean at a surface point (metres), for effects that need the
   * caustic shape but not its animation detail. Sampled at an explicit level, so it may be
   * called from non-uniform control flow.
   */
  bakedAt(surfacePoint: Node<'vec2'>, scale: number): Node<'float'> {
    const cells = surfacePoint.mul(this.cellsPerMetre.mul(scale / BAKE_PERIOD_CELLS));
    const drift = vec2(DRIFT[0], DRIFT[1]).mul(time.mul(this.speed).div(BAKE_PERIOD_CELLS));
    return texture(this.bakeTarget.texture, cells.add(drift)).level(float(1)).r.mul(PATTERN_GAIN);
  }

  /**
   * The hood's light reaching `p` under water: spread and absorption on the slant path down from
   * the surface. Outside the water it is the hood's radiance itself.
   */
  private reach(p: Node<'vec3'>) {
    const { medium } = this;
    const depth = medium.boxMax.y.sub(p.y).toVar();
    const inWater = medium.submerged(p).toVar();
    const cosLight = max(this.lightDirection.y, MIN_COS_LIGHT);
    const slant = depth.div(cosLight).toVar();
    const transmittance = exp(medium.extinction().mul(slant.mul(inWater)).negate());
    const light = transmittance.mul(medium.hoodSpread(depth.mul(inWater))).mul(this.lightRadiance);
    return { depth, inWater, slant, light };
  }

  /** The hood's light at `p` without the caustic pattern, for effects shaded by hand. */
  hoodLight(p: Node<'vec3'> = positionWorld): Node<'vec3'> {
    return Fn(() => this.reach(p).light)();
  }

  /**
   * `hoodLight` at `depth` (m) below the surface, from the uniforms' current values. For light that
   * is the same everywhere in a frame, so the shaders read it as one uniform.
   */
  hoodLightAtDepth(depth: number, target: Color): Color {
    const { medium } = this;
    const below = Math.max(depth, 0);
    const slant = below / Math.max(this.lightDirection.value.y, MIN_COS_LIGHT);
    const h = medium.fixtureHeight.value;
    const spread = (h / (h + below)) ** 2;
    const absorption = medium.absorption.value;
    const scale = medium.absorptionScale.value;
    const scattering = medium.scattering.value;
    const reaching = (a: number): number => Math.exp(-(a * scale + scattering) * slant) * spread;
    return target
      .setRGB(reaching(absorption.x), reaching(absorption.y), reaching(absorption.z))
      .multiply(this.lightRadiance.value);
  }

  /** Colour node for the hood light: radiance x spread x surface-to-point transmittance x caustics. */
  lightColorNode(): Node<'vec3'> {
    return Fn(() => {
      const p = positionWorld;
      const { depth, inWater, slant, light } = this.reach(p);
      const surfacePoint = p.xz.add(this.lightDirection.xz.mul(slant));
      const t = time.mul(this.speed).toVar();
      const q = surfacePoint.mul(this.cellsPerMetre).add(vec2(DRIFT[0], DRIFT[1]).mul(t)).toVar();
      const focus = focusField(q, t, null).toVar();

      const tiled = q.div(BAKE_PERIOD_CELLS).toVar();
      const blur = focus.oneMinus().mul(BAKED_DEFOCUS_BLUR).add(BAKED_BIAS);
      const turned = vec2(
        dot(tiled, vec2(Math.cos(BAKED_TURN), -Math.sin(BAKED_TURN))),
        dot(tiled, vec2(Math.sin(BAKED_TURN), Math.cos(BAKED_TURN))),
      );
      const bakedA = texture(this.bakeTarget.texture, tiled).bias(blur).r;
      const bakedB = texture(
        this.bakeTarget.texture,
        turned.mul(BAKED_SCALE).add(vec2(-0.011, 0.019).mul(t)).add(0.37),
      ).bias(blur).r;
      const bakedPattern = mix(bakedB, bakedA, PATTERN.layerWeights[0]).toVar();

      const pattern = vec3(1).toVar();
      If(this.method.equal(METHOD_ID.texture), () => {
        pattern.assign(vec3(bakedPattern));
      })
        .ElseIf(this.method.equal(METHOD_ID.single), () => {
          pattern.assign(vec3(net(q, t, focus, null)));
        })
        .ElseIf(this.method.equal(METHOD_ID.layered), () => {
          pattern.assign(vec3(layeredPattern(q, t, focus)));
        })
        .Else(() => {
          pattern.assign(
            vec3(
              layeredPattern(q.mul(1 - DISPERSION), t, focus),
              layeredPattern(q, t, focus),
              layeredPattern(q.mul(1 + DISPERSION), t, focus),
            ),
          );
        });

      const formed = smoothstep(0, 0.06, depth);
      const patch = mix(PATTERN.defocusedContrast, 1, focus);
      const amount = this.contrast.mul(patch).mul(formed).mul(inWater);
      const caustic = max(pattern.mul(PATTERN_GAIN).sub(1).mul(amount).add(1), 0);
      return caustic.mul(light);
    })();
  }
}
