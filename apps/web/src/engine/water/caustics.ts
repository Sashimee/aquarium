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
import {
  BAKE,
  BAKED_GAIN,
  FOCUS_BAKE,
  HASH_WRAP,
  lattice,
  PATTERN,
  PATTERN_GAIN,
  tiledFrequency,
} from './causticPattern';
import type { WaterMedium } from './medium';

const TAU = Math.PI * 2;
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
/** The baked focus field slides as its first octave does live, in cells per unit of animation time. */
const BAKED_FOCUS_DRIFT = [
  PATTERN.focusRate / PATTERN.focusOctaves[0].scale,
  (-0.6 * PATTERN.focusRate) / PATTERN.focusOctaves[0].scale,
] as const;
/**
 * Mip bias of the baked tile: sharper than trilinear, since the low tier renders below native
 * resolution and its filaments would otherwise average away; softer where the light is defocused.
 */
const BAKED_BIAS = -1;
const BAKED_DEFOCUS_BLUR = 0.6;
/**
 * The low tier's share of the contrast left where the light is defocused. Its tile is already
 * baked half-defocused, and a phone's small view of the floor often lies inside one defocused
 * patch, where the full swing would leave no net at all.
 */
const BAKED_DEFOCUSED_CONTRAST = 0.65;
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
  mod(id, period ?? HASH_WRAP);

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
 * How far the caustics swing the light about its mean.
 *
 * The frame has one exposure, where an eye looking at white sand adapts to it. With perceived
 * brightness going as the square root of luminance (Stevens), a filament's perceived step is
 * about half the contrast times the square root of the floor's luminance; holding that at the
 * dark sand's level scales the contrast by the square root of the luminance ratio. The caustics
 * are in the hood light's colour, so the reduction applies to everything it lights, fish, rock
 * and coral as well as the sand: on reef sand that is about 0.42 of the dark-sand contrast.
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
  /**
   * The net's contrast in full daylight on dark sand. Not a uniform: the shaders only see it
   * through `contrast` and `shaftContrast`, which `setHood` gates by the main channel.
   */
  readonly strength = { value: BASE_STRENGTH };
  /** What the lit surfaces get; see `causticContrast`. */
  readonly contrast = uniform(0);
  /** What the light shafts get: the strength times the casting share, without the substrate term. */
  readonly shaftContrast = uniform(0);
  readonly cellsPerMetre = uniform(13);
  readonly speed = uniform(0.55);
  readonly method = uniform(METHOD_ID.layered, 'int');
  /** Unit vector from the scene towards the light. */
  readonly lightDirection = uniform(new Vector3(0, 1, 0));
  readonly lightRadiance = uniform(new Color(1, 1, 1));

  private readonly casting = new Color();
  private readonly bakeTarget = new RenderTarget(BAKE.size, BAKE.size, {
    type: HalfFloatType,
    generateMipmaps: true,
    anisotropy: BAKE_ANISOTROPY,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    depthBuffer: false,
  });
  private readonly focusTarget = new RenderTarget(FOCUS_BAKE.size, FOCUS_BAKE.size, {
    generateMipmaps: false,
    minFilter: LinearFilter,
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
   * Call once per frame. The hood's main channel, `main` at `intensity`, fades with `day` into its
   * `moonlight` channel; only the main channel casts caustics (see `castingShare`).
   */
  setHood(
    main: Color,
    intensity: number,
    moonlight: Color,
    day: number,
    substrateAlbedo: Color,
  ): void {
    const casting = this.casting.copy(main).multiplyScalar(intensity * day);
    const radiance = this.lightRadiance.value
      .copy(moonlight)
      .multiplyScalar(1 - day)
      .add(casting);
    const share = castingShare(luminance(casting), luminance(radiance));
    this.contrast.value = causticContrast(this.strength.value, share, luminance(substrateAlbedo));
    this.shaftContrast.value = this.strength.value * share;
  }

  /** Renders the low tier's tiles: one frame of a net, and the focus field. */
  bake(renderer: Renderer): void {
    const netTile = Fn(() => {
      const q = uv().mul(BAKE.periodCells).toVar();
      const t = float(0);
      const focus = focusField(q, t, BAKE.periodCells);
      return vec4(vec3(net(q, t, focus.mul(BAKE.focus), BAKE.periodCells)), 1);
    })();
    const focusTile = Fn(() => {
      const q = uv().mul(FOCUS_BAKE.periodCells);
      return vec4(vec3(focusField(q, float(0), FOCUS_BAKE.periodCells)), 1);
    })();
    const previous = renderer.getRenderTarget();
    for (const [node, target] of [
      [netTile, this.bakeTarget],
      [focusTile, this.focusTarget],
    ] as const) {
      const material = new NodeMaterial();
      material.fragmentNode = node;
      renderer.setRenderTarget(target);
      new QuadMesh(material).render(renderer);
      material.dispose();
    }
    renderer.setRenderTarget(previous);
    this.baked = true;
  }

  dispose(): void {
    this.bakeTarget.dispose();
    this.focusTarget.dispose();
  }

  /**
   * The baked pattern with unit mean at a surface point (metres), for effects that need the
   * caustic shape but not its animation detail. Sampled at an explicit level, so it may be
   * called from non-uniform control flow.
   */
  bakedAt(surfacePoint: Node<'vec2'>, scale: number): Node<'float'> {
    const cells = surfacePoint.mul(this.cellsPerMetre.mul(scale / BAKE.periodCells));
    const drift = fract(vec2(DRIFT[0], DRIFT[1]).mul(time.mul(this.speed).div(BAKE.periodCells)));
    return texture(this.bakeTarget.texture, cells.add(drift)).level(float(1)).r.mul(BAKED_GAIN);
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
      const cells = surfacePoint.mul(this.cellsPerMetre).toVar();
      const drift = vec2(DRIFT[0], DRIFT[1]).mul(t).toVar();
      const focus = float(0).toVar();
      const defocused = float(PATTERN.defocusedContrast).toVar();
      const pattern = vec3(1).toVar();

      If(this.method.equal(METHOD_ID.texture), () => {
        focus.assign(this.bakedFocus(cells, t));
        defocused.assign(BAKED_DEFOCUSED_CONTRAST);
        pattern.assign(vec3(this.bakedPattern(cells, drift, t, focus)));
      }).Else(() => {
        const q = cells.add(drift).toVar();
        focus.assign(focusField(q, t, null));
        If(this.method.equal(METHOD_ID.single), () => {
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
        pattern.mulAssign(PATTERN_GAIN);
      });

      const formed = smoothstep(0, 0.06, depth);
      const patch = mix(defocused, 1, focus);
      const amount = this.contrast.mul(patch).mul(formed).mul(inWater);
      const caustic = max(pattern.sub(1).mul(amount).add(1), 0);
      return caustic.mul(light);
    })();
  }

  /**
   * The baked focus field at `cells`. Only the drift, the same at every pixel, is wrapped to the
   * tile: wrapping the per-pixel coordinate would break the derivatives the mip choice needs.
   */
  private bakedFocus(cells: Node<'vec2'>, t: Node<'float'>): Node<'float'> {
    const drift = fract(
      vec2(BAKED_FOCUS_DRIFT[0], BAKED_FOCUS_DRIFT[1]).mul(t.div(FOCUS_BAKE.periodCells)),
    );
    return texture(this.focusTarget.texture, cells.div(FOCUS_BAKE.periodCells).add(drift)).r;
  }

  /** Two taps of the baked net, the second turned and scaled so the two tiles never line up. */
  private bakedPattern(
    cells: Node<'vec2'>,
    drift: Node<'vec2'>,
    t: Node<'float'>,
    focus: Node<'float'>,
  ): Node<'float'> {
    const blur = focus.oneMinus().mul(BAKED_DEFOCUS_BLUR).add(BAKED_BIAS).toVar();
    const turn = (p: Node<'vec2'>): Node<'vec2'> =>
      vec2(
        dot(p, vec2(Math.cos(BAKED_TURN), -Math.sin(BAKED_TURN))),
        dot(p, vec2(Math.sin(BAKED_TURN), Math.cos(BAKED_TURN))),
      ).mul(BAKED_SCALE);
    const tile = cells.div(BAKE.periodCells).toVar();
    const tileDrift = drift.div(BAKE.periodCells).toVar();
    const a = texture(this.bakeTarget.texture, tile.add(fract(tileDrift))).bias(blur).r;
    const driftB = fract(turn(tileDrift).add(vec2(-0.011, 0.019).mul(t)).add(0.37));
    const b = texture(this.bakeTarget.texture, turn(tile).add(driftB)).bias(blur).r;
    return mix(b, a, PATTERN.layerWeights[0]).mul(BAKED_GAIN);
  }
}
