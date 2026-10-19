import {
  MeshPhysicalNodeMaterial,
  Vector3,
  DoubleSide,
  type MeshStandardMaterial,
  type Node,
  type NodeBuilder,
  type UniformNode,
} from 'three/webgpu';
import {
  abs,
  atan,
  attribute,
  cameraPosition,
  clamp,
  color,
  cos,
  cross,
  dFdx,
  dFdy,
  dot,
  exp2,
  float,
  floor,
  fract,
  frameId,
  Fn,
  fwidth,
  If,
  instancedDynamicBufferAttribute,
  length,
  log2,
  luminance,
  materialRoughness,
  max,
  min,
  mix,
  mx_noise_float,
  normalGeometry,
  normalize,
  normalLocal,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionPrevious,
  positionWorld,
  pow,
  select,
  sign,
  sin,
  smoothstep,
  step,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { FIN_ATTRIBUTE, LEG_PART_ID } from './assets';
import {
  InstanceSlot,
  WALKER_INSTANCE_STRIDE,
  WalkerSlot,
  type FishInstanceData,
} from './instances';
import { idIs, walkerDeformation, type Deformation, type WalkerRig } from './limbs';
import type { FishRenderProfile } from './profiles';
import { TAIL_AMPLITUDE_BODY_LENGTHS, type SwimModeParams } from './swim';

export interface FishLighting {
  /** Unit vector towards the main light. */
  readonly lightDirection: UniformNode<'vec3', Vector3>;
  /** The main light reaching the fragment, without its caustics. */
  readonly light: Node<'vec3'>;
}

/**
 * How fin membranes let the background through:
 * - `cutout`: opaque inside the alpha silhouette, no back-lighting;
 * - `coverage`: alpha-to-coverage, which needs an MSAA target and degrades to a cutout without;
 * - `stochastic`: animated screen-door, only for a pipeline with a temporal resolve.
 */
export type FinRendering = 'cutout' | 'coverage' | 'stochastic';

export interface FishMaterialFeatures {
  readonly fins: FinRendering;
  readonly iridescence: boolean;
  readonly clearcoat: boolean;
  /** Opercular and buccal pumping in the vertex deformation. */
  readonly gills: boolean;
}

export interface FishMaterialConfig {
  readonly source: MeshStandardMaterial;
  /** The model the material draws, which may be the profile's male one. */
  readonly assetId: string;
  readonly profile: FishRenderProfile;
  readonly locomotion:
    | { readonly kind: 'swim'; readonly mode: SwimModeParams }
    | { readonly kind: 'walk'; readonly rig: WalkerRig };
  /** Model-space z of the snout and of the tail tip. */
  readonly zMax: number;
  readonly zMin: number;
  readonly instances: FishInstanceData;
  readonly lighting: FishLighting;
  /** The fin attribute is a vec3 whose third component is the `_mouth` weight. */
  readonly mouth: boolean;
  /** The species flares (trait `flare-display`), so it gets fin spread and gill flare. */
  readonly displays: boolean;
}

const FIN_ID = { caudal: 1, dorsal: 2, anal: 3, pectoral: 4, pelvic: 5 } as const;
/** Head bend relative to the tail in a turn: the head leads, the rear body follows the path. */
const HEAD_BEND = 0.35;
const CAUDAL_LAG = 0.06;
const CAUDAL_LAG_PHASE = 1.2;
const PELVIC_AMPLITUDE = 0.015;
/**
 * The models carry no gill mask, so the gill cover is placed by body proportion: its rear edge at
 * about a fifth of the total length behind the snout, as in the small teleosts the tanks hold. The
 * cover widens towards that edge and the flank behind it stays put, which shades the gill slit.
 */
const GILL_EDGE_S = 0.2;
const GILL_COVER_S = 0.08;
const GILL_FALLOFF_S = 0.03;
/** Lateral widening of the head at the gill edge with the covers fully flared. */
const GILL_FLARE = 0.08;
/**
 * A displaying fish erects its dorsal and anal fins and fans its tail into a half
 * disc, so the three read as one ring around the body (Simpson 1968, Anim Behav Monogr 1:1, for
 * Betta splendens). Each fin turns in the body's plane about a pivot on the axis, by an angle that
 * grows from 0 at the root to these at the edge, so the root stays on the body. Pivots are placed
 * by body proportion, as the gill edge is; angles are visual estimates, in radians.
 */
const DORSAL_PIVOT_S = 0.4;
const DORSAL_ERECT = 0.4;
const ANAL_PIVOT_S = 0.3;
const ANAL_ERECT = 0.22;
const PEDUNCLE_S = 0.65;
/** The tail turns up by this, and each ray further from its rest angle off the axis by this share. */
const CAUDAL_LIFT = 0.35;
const CAUDAL_FAN = 0.3;
/** Unpaired fin edges stretch this far again from their pivot. */
const FIN_STRETCH = 0.12;
/** Pelvic fins splay sideways in display, in body lengths at the fin tip. */
const PELVIC_SPLAY = 0.06;
/**
 * Fin rays at or ahead of their pivot stay put, and the turn grows over this share of the body
 * length behind it; a turn about the pivot would fold them into the body.
 */
const DISPLAY_PIVOT_RAMP_S = 0.04;
/** Median fins held taut in display ripple at this share of their swimming undulation. */
const DISPLAY_FIN_RIPPLE = 0.4;
/**
 * A flaring betta swings its opercula out to show the branchiostegal membrane beneath (Simpson
 * 1968): the head widens at the gill edge and the throat drops. Visual estimates.
 */
const GILL_DISPLAY_FLARE = 0.8;
const GILL_DISPLAY_DROP = 0.45;
/**
 * Drop of the jaw tip at a feeding bite's full gape, in body lengths: a lower jaw a tenth of the
 * body long swung down by about 14°.
 */
const JAW_DROP = 0.025;
/**
 * The baked mouth weight is about 0.5 along the mouth slit and the jaw line, and its soft upper
 * edge reaches the lower rim of the eye. Only the part above this moves, so the eye and the upper
 * lip stay put and the jaw swings from its rear.
 */
const JAW_WEIGHT_FROM = 0.45;
/** Guanine (n ≈ 1.83) platelets are the reflectors in fish iridophores (Land 1972). */
const GUANINE_IOR = 1.83;
export const FIN_OPACITY_FLOOR = 0.2;
/**
 * A resting or stressed fish tilts its iridophore platelets closer together: the reflection dims
 * and shifts towards violet, as the neon tetra's stripe does at night (Yoshioka et al. 2011).
 */
const NIGHT_IRIDESCENCE_LOSS = 0.5;
const NIGHT_PLATELET_SHRINK = 0.12;
/**
 * Newborn fry are nearly transparent: a few melanophores over a glassy, yolk-tinted body, with the
 * adult chromatophores filling in through the juvenile stage. A fry keeps this much of its
 * livery's saturation and contrast, over this lift.
 */
const FRY_SATURATION = 0.15;
const FRY_CONTRAST = 0.45;
const FRY_LIFT: readonly [number, number, number] = [0.3, 0.29, 0.25];
/** How much of a fry's body the backlit-membrane translucency reaches. */
const FRY_TRANSLUCENCY = 0.6;
/** Below this alpha a texel is outside the fin silhouette in every mode. */
const SILHOUETTE_ALPHA = 0.1;
/** `antialias: true` gives four MSAA samples on both backends. */
const COVERAGE_SAMPLES = 4;
/** Golden-ratio step that decorrelates consecutive frames of the noise. */
const FRAME_NOISE_STEP = 0.618034;

/**
 * Asset materials with this name are not skin: they keep the roughness, metalness and colour the
 * asset authored instead of taking the species roughness and the per-fish tint. Matched by name
 * because the asset pipeline already names the pleco's glossy eye spheres so (`glossy-eyes.ts`).
 */
export const AUTHORED_SURFACE_MATERIAL = 'Eye';

export function keepsAuthoredSurface(source: MeshStandardMaterial): boolean {
  return source.name === AUTHORED_SURFACE_MATERIAL;
}

/** `base` faded from the adult livery towards a fry's pale, glassy body by `youth` 0..1. */
export function juvenileLivery(base: Node<'vec3'>, youth: Node<'float'>): Node<'vec3'> {
  const grey = vec3(luminance(base));
  const fry = mix(grey, base, FRY_SATURATION)
    .mul(FRY_CONTRAST)
    .add(vec3(...FRY_LIFT));
  return mix(base, fry, youth);
}

/** The share of the body that glows with backlit translucency: the fins, and a fry all over. */
export function translucentShare(fins: Node<'float'>, youth: Node<'float'>): Node<'float'> {
  return max(fins, youth.mul(FRY_TRANSLUCENCY));
}

/** smoothstep(a, b, x) and its derivative in x. */
function smoothRamp(a: number, b: number, x: Node<'float'>): [Node<'float'>, Node<'float'>] {
  const t = clamp(x.sub(a).div(b - a), 0, 1);
  return [t.mul(t).mul(t.mul(-2).add(3)), t.mul(t.oneMinus()).mul(6 / (b - a))];
}

export interface BodyBend {
  /** 0 at the snout, 1 at the tail tip. */
  readonly s: Node<'float'>;
  /** Body-wave phase at `s`. */
  readonly arg: Node<'float'>;
  /** Lateral (model x) offset of the body wave and the turn bend. */
  readonly offset: Node<'float'>;
  /** d(body wave)/ds. */
  readonly slopeS: Node<'float'>;
  /** d(turn bend)/dz. */
  readonly bendSlope: Node<'float'>;
}

/**
 * The travelling body wave and the turn bend at model z, from the instance's `swim` vec4 (scale,
 * phase, amplitude scale, curvature); shared by the meshes and the impostor so the two bend alike.
 */
export function bodyBend(
  mode: SwimModeParams,
  zMin: number,
  zMax: number,
  swim: Node<'vec4'>,
  z: Node<'float'>,
): BodyBend {
  const zLen = zMax - zMin;
  const [c0, c1, c2] = mode.envelope;
  const k = (2 * Math.PI) / mode.wavelength;
  const phase = swim.y;
  const amp = swim.z;
  const curvature = swim.w;

  const s = clamp(float(zMax).sub(z).div(zLen), 0, 1).toVar();
  const envelope = float(c0).add(s.mul(c1)).add(s.mul(s).mul(c2));
  const envelopeSlope = float(c1).add(s.mul(2 * c2));
  const arg = s.mul(k).sub(phase).toVar();
  const bodyAmplitude = amp.mul((TAIL_AMPLITUDE_BODY_LENGTHS / 2) * zLen * mode.bodyWave);
  const body = bodyAmplitude.mul(envelope).mul(sin(arg));
  const slopeS = bodyAmplitude.mul(envelopeSlope.mul(sin(arg)).add(envelope.mul(k).mul(cos(arg))));

  const headSide = step(0, z);
  const bendWeight = mix(float(1), float(HEAD_BEND), headSide);
  const bend = curvature.mul(0.5).mul(z).mul(z).mul(bendWeight);
  const bendSlope = curvature.mul(z).mul(bendWeight);
  return { s, arg, offset: body.add(bend), slopeS, bendSlope };
}

export function rotateByQuat(q: Node<'vec4'>, v: Node<'vec3'>): Node<'vec3'> {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
}

/**
 * Jimenez's interleaved gradient noise (2014) on a lattice of cells: neighbours take well-spread
 * values, so a close-up membrane dithers evenly where a white-noise hash leaves clumps and gaps.
 */
function interleavedGradient(cell: Node<'vec2'>): Node<'float'> {
  return fract(fract(dot(cell, vec2(0.06711056, 0.00583715))).mul(52.9829189));
}

/** Dave Hoskins' "hash without sine" hash13: no trigonometry, so it is stable on mobile GPUs. */
function hash13(cell: Node<'vec3'>): Node<'float'> {
  const p = fract(cell.mul(0.1031)).toVar();
  const q = p.add(dot(p, p.zyx.add(31.32)));
  return fract(q.x.add(q.y).mul(q.z));
}

/**
 * Sharpness of the plane choice: only where the normal is within about 8° of a diagonal do both
 * planes get a real share.
 */
const PLANE_SHARPNESS = 8;

/**
 * IGN over a rest-pose axis plane, picked per cell at random in proportion to how much the surface
 * faces it (stochastic triplanar). A hard pick by the dominant axis would cut a seam across a
 * curved fin where its normal crosses a diagonal; a random pick turns that line into a narrow band
 * of white noise, and every cell still draws one uniform IGN value. Each layer of cells along the
 * third axis is shifted by the step IGN uses between frames, so the two sides of a fish (paired
 * fins, the flanks of a fin's fold) do not share a pattern. `transposed` runs the gradient across
 * the plane the other way, which keeps a coarser lattice's values from following the finer one's.
 */
function surfaceCellNoise(cell: Node<'vec3'>, transposed: boolean): Node<'float'> {
  const n = abs(normalGeometry);
  const w = pow(n, vec3(PLANE_SHARPNESS));
  const pick = hash13(cell).mul(w.x.add(w.y).add(w.z));
  const onX = pick.lessThan(w.x);
  const onY = pick.lessThan(w.x.add(w.y));
  const plane = select(onX, cell.yz, select(onY, cell.zx, cell.xy));
  const layer = select(onX, cell.x, select(onY, cell.y, cell.z));
  const oriented = transposed ? plane.yx.add(vec2(37, 59)) : plane;
  return interleavedGradient(oriented.add(layer.mul(5.588238)));
}

/**
 * Uniform noise anchored to the surface: hashed alpha testing (Wyman & McGuire 2017). Cells are
 * cut from the rest-pose model position at about one per pixel, so the pattern rides along with
 * a beating fin instead of crawling over it as a screen-space pattern does. The cell size steps in
 * powers of two with the distance, blended between the two nearest and remapped to stay uniform.
 * The per-fish offset keeps two overlapping fins from sharing a pattern.
 */
function surfaceNoise(seed: Node<'float'>): Node<'float'> {
  const p = positionGeometry;
  const footprint = max(max(length(dFdx(p)), length(dFdy(p))), 1e-9);
  const level = log2(footprint);
  const fine = exp2(floor(level));
  const offset = vec3(seed.mul(61.3), seed.mul(29.7), seed.mul(17.1)).floor();
  const a = surfaceCellNoise(floor(p.div(fine)).add(offset), false);
  const b = surfaceCellNoise(floor(p.div(fine.mul(2))).add(offset), true);
  const t = fract(level);
  const x = mix(a, b, t);
  const edge = max(min(t, t.oneMinus()), 1e-4);
  const spread = edge.mul(edge.oneMinus()).mul(2);
  const low = x.mul(x).div(spread);
  const middle = x.sub(edge.mul(0.5)).div(edge.oneMinus());
  const high = float(1).sub(x.oneMinus().mul(x.oneMinus()).div(spread));
  const uniform = select(x.lessThan(edge), low, select(x.lessThan(edge.oneMinus()), middle, high));
  return clamp(uniform, 0, 1);
}

/**
 * A pixel survives when its alpha beats the surface noise. The noise shifts every frame so a
 * temporal resolve averages it into a blend; without one it is raw stipple.
 */
function screenDoor(alpha: Node<'float'>, seed: Node<'float'>): Node<'bool'> {
  const frame = float(frameId).mod(64).mul(FRAME_NOISE_STEP);
  return alpha.greaterThan(fract(surfaceNoise(seed).add(frame)));
}

/**
 * Alpha-to-coverage keeps only COVERAGE_SAMPLES + 1 levels, so a soft membrane would band and its
 * faint rim would round to nothing. A fixed offset of up to one sample step dithers between
 * neighbouring levels, which the MSAA resolve averages back into a gradient. The offset shrinks to
 * zero towards alpha 1, so opaque skin keeps every sample.
 */
function ditheredCoverage(alpha: Node<'float'>, seed: Node<'float'>): Node<'float'> {
  const reach = min(alpha.oneMinus().mul(2), 1 / COVERAGE_SAMPLES);
  return alpha.add(surfaceNoise(seed).sub(0.5).mul(reach));
}

export interface FinDisplayInput {
  readonly y: Node<'float'>;
  readonly z: Node<'float'>;
  readonly mask: Node<'float'>;
  readonly display: Node<'float'>;
  readonly isDorsal: Node<'float'>;
  readonly isAnal: Node<'float'>;
  readonly isCaudal: Node<'float'>;
  readonly zMax: number;
  readonly zLen: number;
}

/**
 * The display turn and stretch of an unpaired fin vertex in the body's plane, as model-space y and
 * z, with the turn's cosine and sine for the normal.
 */
export function finDisplay(input: FinDisplayInput): {
  y: Node<'float'>;
  z: Node<'float'>;
  turnCos: Node<'float'>;
  turnSin: Node<'float'>;
} {
  const { y, z, mask, display, isDorsal, isAnal, isCaudal, zMax, zLen } = input;
  const pivotZ = isDorsal
    .mul(zMax - DORSAL_PIVOT_S * zLen)
    .add(isAnal.mul(zMax - ANAL_PIVOT_S * zLen))
    .add(isCaudal.mul(zMax - PEDUNCLE_S * zLen));
  const fromPivotZ = z.sub(pivotZ).toVar();
  const behindPivot = fromPivotZ.negate().toVar();
  const spread = display
    .mul(mask)
    .mul(smoothstep(0, DISPLAY_PIVOT_RAMP_S * zLen, behindPivot))
    .toVar();
  // Clamped off zero: atan2(0, 0) is undefined in GLSL, and ahead of the pivot it would wrap by 2π.
  const offAxis = atan(y, max(behindPivot, 1e-6 * zLen));
  const turn = spread
    .mul(
      isDorsal
        .mul(DORSAL_ERECT)
        .sub(isAnal.mul(ANAL_ERECT))
        .add(isCaudal.mul(offAxis.mul(CAUDAL_FAN).add(CAUDAL_LIFT))),
    )
    .toVar();
  const stretch = spread.mul(isDorsal.add(isAnal).add(isCaudal)).mul(FIN_STRETCH).add(1).toVar();
  const turnCos = cos(turn).toVar();
  const turnSin = sin(turn).toVar();
  // Turned towards +y from the tail, z' = z·cos + y·sin and y' = y·cos − z·sin about the pivot.
  return {
    y: y.mul(turnCos).sub(fromPivotZ.mul(turnSin)).mul(stretch),
    z: fromPivotZ.mul(turnCos).add(y.mul(turnSin)).mul(stretch).add(pivotZ),
    turnCos,
    turnSin,
  };
}

/**
 * Ich trophonts sit in the epidermis as white cysts 0.5–1 mm across (Matthews 2005), whatever the
 * size of the fish, so the spots are laid out in rest-pose model metres. Each lattice cell holds at
 * most one cyst, kept clear of the cell walls; two lattices offset by half a cell hide the grid.
 */
const ICH_CELL_M = 0.0016;
const ICH_RADIUS_M: readonly [number, number] = [0.00025, 0.00045];
/** A heavy infestation is a dense sprinkle of separate grains, not a white crust. */
const ICH_MAX_DENSITY = 0.9;
const ICH_LATTICE_SHIFT = 0.5;
/** Linear albedo of the cysts: opaque, slightly creamy white. */
const ICH_WHITE = vec3(0.78, 0.78, 0.73);
/**
 * Piscinoodinium trophonts are 12–100 µm, far below a pixel, so velvet reads as a powdery film:
 * blotches of a few millimetres with a fine grain that only resolves in a close-up. The dust
 * gathers on the back and the fins first.
 */
const VELVET_PATCH_M = 0.004;
const VELVET_GRAIN_M = 0.00012;
const VELVET_GRAIN_EDGE = 0.12;
/**
 * Even a fish about to die of velvet keeps its pattern visible through the dust, which is why
 * keepers spot it with a torch at a glancing angle; past this share of the skin it reads as paint.
 */
const VELVET_MAX_COVER = 0.55;
/** Fins dust over a little sooner than the flank, not as a solid sheet. */
const VELVET_FIN_WEIGHT = 0.8;
/** Linear albedo of the rusty-gold dust. */
const VELVET_GOLD = vec3(0.52, 0.37, 0.13);
const VELVET_ROUGHNESS = 0.85;
/** The dust film's coverage grows with the path through it, up to this grazing cosine. */
const VELVET_MIN_COSINE = 0.2;
/**
 * Fin rot eats the membrane back from the margin: at full severity this far down the fin mask.
 * The edge is torn into notches stretched along the fin rays, and the dying tissue just inside
 * it turns milky, with reddened, blood-streaked membrane behind that.
 */
const ROT_DEPTH = 0.6;
const ROT_RAGGED = 0.22;
const ROT_NOTCH_M = 0.0025;
const ROT_FRAY_M = 0.0007;
/** Notches run along the rays: the noise is this many times coarser along the ray axis. */
const ROT_RAY_STRETCH = 4;
/** Width, in fin-mask units, of the band behind the front that the marks' depth measures. */
const ROT_BAND = 0.25;
const ROT_NECROTIC = vec3(0.6, 0.58, 0.52);
const ROT_INFLAMED = vec3(1, 0.42, 0.38);

/**
 * Expected share of the surface covered by one ich lattice at full density. By Delesse's principle
 * a plane through randomly placed spheres is covered by their volume fraction: (4π/3)·E[r³]/C³,
 * with r uniform over the radius range.
 */
export function ichLatticeCover(): number {
  const [a, b] = ICH_RADIUS_M;
  const meanCube = (b ** 4 - a ** 4) / (4 * (b - a));
  return ((4 * Math.PI) / 3) * (meanCube / ICH_CELL_M ** 3);
}

/** Dave Hoskins' hash33, companion to `hash13`. */
function hash33(cell: Node<'vec3'>): Node<'vec3'> {
  const p = fract(cell.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  const q = p.add(dot(p, p.yxz.add(33.33)));
  return fract(q.xxy.add(q.yxx).mul(q.zyx));
}

/**
 * One lattice of ich cysts. Under a pixel the cysts would shimmer, so they fade into their
 * expected coverage as the footprint outgrows them.
 */
function ichLattice(
  p: Node<'vec3'>,
  shift: number,
  density: Node<'float'>,
  footprint: Node<'float'>,
): Node<'float'> {
  const q = p.div(ICH_CELL_M).add(shift);
  const cell = floor(q);
  const rMin = ICH_RADIUS_M[0] / ICH_CELL_M;
  const rMax = ICH_RADIUS_M[1] / ICH_CELL_M;
  const centre = hash33(cell.add(shift * 7.1))
    .mul(1 - 2 * rMax)
    .add(rMax);
  const radius = mix(float(rMin), float(rMax), hash13(cell.add(19.19 + shift)));
  const lit = select(hash13(cell.add(53.7 + shift)).lessThan(density), float(1), float(0));
  const w = footprint.div(ICH_CELL_M);
  const d = length(q.sub(cell).sub(centre));
  const sharp = smoothstep(radius.sub(w), radius.add(w), d).oneMinus().mul(lit);
  const fade = smoothstep(0.35, 1, w.div((rMin + rMax) / 2));
  return mix(sharp, density.mul(ichLatticeCover()), fade);
}

/**
 * The visible signs of disease as (ich cover, velvet dust cover, fin kept 0..1, depth behind the
 * fin rot front 0..1 over `ROT_BAND`), from the ich, fin rot and velvet severities, the fin mask
 * and id, and the membrane weight. A healthy fish branches past every sign, so it costs one
 * comparison per disease, and its marks are exactly (0, 0, 1, 1), which leaves every blend as it
 * was. Derivatives are taken before the branches: WGSL allows them only in uniform control flow.
 * So is the shading normal: three declares it where it is first built and assigns it there only,
 * so built inside a branch it stays zero for every fish that skips it (#763, #777).
 */
const diseaseMarks = Fn(
  ([signs, finMask, finId, membrane]: [
    Node<'vec3'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
  ]): Node<'vec4'> => {
    const p = positionGeometry;
    const footprint = max(max(length(dFdx(p)), length(dFdy(p))), 1e-9).toVar();
    const maskWidth = max(fwidth(finMask), 1e-4).toVar();
    const toEye = normalize(cameraPosition.sub(positionWorld));
    const facing = abs(dot(normalWorld, toEye)).toVar();
    const ich = float(0).toVar();
    const dust = float(0).toVar();
    const kept = float(1).toVar();
    const depth = float(1).toVar();

    If(signs.x.greaterThan(0), () => {
      const density = signs.x.mul(ICH_MAX_DENSITY);
      const a = ichLattice(p, 0, density, footprint);
      const b = ichLattice(p, ICH_LATTICE_SHIFT, density, footprint);
      ich.assign(a.add(b).sub(a.mul(b)));
    });

    If(signs.y.greaterThan(0).and(membrane.greaterThan(0.5)), () => {
      const rot = signs.y;
      const alongZ = idIs(finId, FIN_ID.caudal)
        .add(idIs(finId, FIN_ID.pectoral))
        .add(idIs(finId, FIN_ID.pelvic));
      const stretch = mix(vec3(1, 1 / ROT_RAY_STRETCH, 1), vec3(1, 1, 1 / ROT_RAY_STRETCH), alongZ);
      const q = p.mul(stretch);
      const ragged = mx_noise_float(q.div(ROT_NOTCH_M))
        .mul(0.7)
        .add(mx_noise_float(q.div(ROT_FRAY_M)).mul(0.3));
      const front = float(1)
        .sub(rot.mul(ROT_DEPTH))
        .add(ragged.mul(smoothstep(0, 0.25, rot).mul(ROT_RAGGED)))
        .toVar();
      kept.assign(smoothstep(front.sub(maskWidth), front.add(maskWidth), finMask).oneMinus());
      depth.assign(clamp(front.sub(finMask).div(ROT_BAND), 0, 1));
    });

    If(signs.z.greaterThan(0), () => {
      const dorsal = smoothstep(-0.3, 0.9, normalGeometry.y);
      const where = max(mix(float(0.35), float(1), dorsal), membrane.mul(VELVET_FIN_WEIGHT));
      const patch = mx_noise_float(p.div(VELVET_PATCH_M)).mul(0.5).add(0.5);
      const cover = clamp(
        signs.z.mul(where).mul(patch.mul(0.9).add(0.55)).mul(VELVET_MAX_COVER),
        0,
        VELVET_MAX_COVER,
      ).toVar();
      const grain = mx_noise_float(p.div(VELVET_GRAIN_M)).mul(0.5).add(0.5);
      const edge = VELVET_GRAIN_EDGE;
      const threshold = float(1 + edge).sub(cover.mul(1 + 2 * edge));
      const near = smoothstep(threshold.sub(edge), threshold.add(edge), grain);
      const film = mix(near, cover, smoothstep(0.5, 2, footprint.div(VELVET_GRAIN_M)));
      const cosine = max(facing, VELVET_MIN_COSINE);
      dust.assign(float(1).sub(pow(film.oneMinus(), cosine.reciprocal())));
    });

    return vec4(ich, dust, kept, depth);
  },
);

/** `albedo` with the signs in `marks` painted on, for the severities `signs`. */
function diseasedAlbedo(
  albedo: Node<'vec3'>,
  marks: Node<'vec4'>,
  signs: Node<'vec3'>,
): Node<'vec3'> {
  const rot = signs.y;
  const necrotic = smoothstep(0, 0.35, marks.w)
    .oneMinus()
    .mul(min(rot.mul(3), 1))
    .mul(0.75);
  const inflamed = smoothstep(0.15, 0.45, marks.w)
    .mul(smoothstep(0.55, 0.95, marks.w).oneMinus())
    .mul(smoothstep(0.35, 0.9, rot))
    .mul(0.6);
  const rotted = mix(mix(albedo, albedo.mul(ROT_INFLAMED), inflamed), ROT_NECROTIC, necrotic);
  const spotted = mix(rotted, ICH_WHITE, marks.x);
  return mix(spotted, VELVET_GOLD, marks.y);
}

/**
 * Fish skin and fins on top of three's physical model, with the swimming deformation applied in
 * model space before instancing, so every instance shares one mesh.
 */
export class FishMaterial extends MeshPhysicalNodeMaterial {
  private readonly still: Deformation;
  private readonly breathing: Deformation;
  private deformation: Deformation;
  private readonly config: FishMaterialConfig;
  private readonly instanceNodes = new Map<number, Node<'vec4'>>();

  constructor(config: FishMaterialConfig) {
    super();
    this.config = config;
    const { source, profile } = config;
    this.name = `fish:${config.assetId}:${source.name}`;
    this.side = DoubleSide;
    if (keepsAuthoredSurface(source)) {
      this.roughness = source.roughness;
      this.roughnessMap = source.roughnessMap;
      this.metalness = source.metalness;
      this.metalnessMap = source.metalnessMap;
    } else {
      this.roughness = profile.roughness;
      this.metalness = 0;
    }
    this.normalMap = source.normalMap;
    this.normalScale.copy(source.normalScale);
    this.clearcoatRoughness = 0.08;
    this.iridescenceIOR = GUANINE_IOR;

    const { locomotion } = config;
    if (locomotion.kind === 'walk') {
      if (config.instances.stride !== WALKER_INSTANCE_STRIDE) {
        throw new Error(`${this.name}: a walker needs instance data with the walker stride`);
      }
      const walker = walkerDeformation(locomotion.rig, {
        look: this.instanceVec4(8),
        walk: this.instanceVec4(WalkerSlot.LegPhase),
        act: this.instanceVec4(WalkerSlot.Pick),
      });
      this.still = walker;
      this.breathing = walker;
    } else {
      this.still = this.buildDeformation(locomotion.mode, false);
      this.breathing = this.buildDeformation(locomotion.mode, true);
    }
    this.deformation = this.still;
    const { position } = this.still;

    const orientation = this.instanceVec4(0);
    const scale = this.instanceVec4(4).x;
    // The shadow pass uses a plain override material that instances the undeformed geometry.
    this.castShadowPositionNode = positionLocal.add(
      rotateByQuat(orientation, position.sub(positionGeometry).mul(scale)),
    );
    this.setFeatures({ fins: 'coverage', iridescence: true, clearcoat: true, gills: true });
  }

  /** One node per slot: each call would otherwise add its own vertex attribute. */
  private instanceVec4(offset: number): Node<'vec4'> {
    let node = this.instanceNodes.get(offset);
    if (node === undefined) {
      node = instancedDynamicBufferAttribute(
        this.config.instances.buffer,
        'vec4',
        this.config.instances.stride,
        offset,
      );
      this.instanceNodes.set(offset, node);
    }
    return node;
  }

  /** `_fin_mask` and `_fin_id`, whichever layout the fin attribute has. */
  private finMaskAndId(): Node<'vec2'> {
    return this.config.locomotion.kind === 'walk' || this.config.mouth
      ? attribute<'vec3'>(FIN_ATTRIBUTE, 'vec3').xy
      : attribute<'vec2'>(FIN_ATTRIBUTE, 'vec2');
  }

  private buildDeformation(mode: SwimModeParams, gills: boolean): Deformation {
    const { zMax, zMin } = this.config;
    const zLen = zMax - zMin;
    const k = (2 * Math.PI) / mode.wavelength;
    const swim = this.instanceVec4(4);
    const look = this.instanceVec4(8);
    const amp = swim.z;
    const finPhase = look.x;
    const fin = this.finMaskAndId();
    const mask = fin.x;
    const id = fin.y;
    const p = positionGeometry;
    const { s, arg, offset, slopeS: bodySlopeS, bendSlope } = bodyBend(mode, zMin, zMax, swim, p.z);

    const breath = this.instanceVec4(16);
    const display = breath.y;
    const gillFlare = breath.z;
    const { displays } = this.config;
    const side = sign(p.x);
    const isCaudal = idIs(id, FIN_ID.caudal);
    const isDorsal = idIs(id, FIN_ID.dorsal);
    const isAnal = idIs(id, FIN_ID.anal);
    const isMedian = isDorsal.add(isAnal);
    const caudal = isCaudal
      .mul(mask.mul(mask))
      .mul(amp.mul(CAUDAL_LAG * zLen))
      .mul(sin(arg.sub(CAUDAL_LAG_PHASE)));
    let median: Node<'float'> = isMedian
      .mul(mask)
      .mul(mode.medianFin * zLen)
      .mul(sin(s.mul(k * 1.5).sub(finPhase)))
      .mul(amp.mul(0.5).add(0.5));
    const pectoral = idIs(id, FIN_ID.pectoral)
      .mul(mask)
      .mul(mode.pectoral * zLen);
    const pectoralOut = pectoral.mul(side).mul(sin(finPhase).mul(0.5).add(0.5));
    const pectoralRow = pectoral.mul(0.6).mul(cos(finPhase));
    const pelvicFin = idIs(id, FIN_ID.pelvic).mul(mask).mul(side);
    let pelvic: Node<'float'> = pelvicFin.mul(PELVIC_AMPLITUDE * zLen).mul(sin(finPhase.add(1)));
    if (displays) {
      median = median.mul(display.mul(DISPLAY_FIN_RIPPLE - 1).add(1));
      pelvic = pelvic.add(pelvicFin.mul(display).mul(PELVIC_SPLAY * zLen));
    }

    const dx = offset.add(caudal).add(median).add(pectoralOut).add(pelvic);
    const n = normalGeometry;
    let x: Node<'float'> = p.x.add(dx);
    let nx: Node<'float'> = n.x;
    let slopeS: Node<'float'> = bodySlopeS;
    const [cover, coverSlope] = smoothRamp(GILL_EDGE_S - GILL_COVER_S, GILL_EDGE_S, s);
    const [behind, behindSlope] = smoothRamp(GILL_EDGE_S, GILL_EDGE_S + GILL_FALLOFF_S, s);
    const opercular = cover.mul(behind.oneMinus()).toVar();
    const skin = smoothstep(0.08, 0.5, mask).oneMinus().toVar();
    const pumped = gills ? this.instanceVec4(12).w.mul(GILL_FLARE) : null;
    const flared = displays ? gillFlare.mul(GILL_DISPLAY_FLARE) : null;
    const opening = pumped !== null && flared !== null ? pumped.add(flared) : (pumped ?? flared);
    if (opening !== null) {
      // x' = x·(1 + g(z)) + h(z); normals transform by the inverse transpose of its Jacobian:
      // n_x /= 1 + g, then n_z -= (x·g'(z) + h'(z))·n_x.
      const flare = opening.mul(skin);
      const widen = flare.mul(opercular).add(1).toVar();
      const widenSlopeS = flare.mul(coverSlope.mul(behind.oneMinus()).sub(cover.mul(behindSlope)));
      x = p.x.mul(widen).add(dx);
      nx = n.x.div(widen);
      slopeS = slopeS.add(p.x.mul(widenSlopeS));
    }
    let y: Node<'float'> = p.y;
    let z: Node<'float'> = p.z;
    let ny: Node<'float'> = n.y;
    let nz: Node<'float'> = n.z;
    if (displays) {
      const fin = finDisplay({
        y: p.y,
        z: p.z,
        mask,
        display,
        isDorsal,
        isAnal,
        isCaudal,
        zMax,
        zLen,
      });
      const { turnCos, turnSin } = fin;
      const throat = gillFlare
        .mul(GILL_DISPLAY_DROP)
        .mul(skin)
        .mul(opercular)
        .mul(step(p.y, 0))
        .add(1)
        .toVar();
      // The membranes face ±x, so the stretch and the fin mask's missing gradient barely turn them.
      y = fin.y.mul(throat);
      z = fin.z;
      ny = n.y.mul(turnCos).sub(n.z.mul(turnSin)).div(throat);
      nz = n.z.mul(turnCos).add(n.y.mul(turnSin));
    }
    if (gills && this.config.mouth) {
      const jaw = smoothstep(JAW_WEIGHT_FROM, 1, attribute<'vec3'>(FIN_ATTRIBUTE, 'vec3').z);
      const weight = jaw.mul(smoothstep(0, GILL_EDGE_S, s).oneMinus());
      const opening = breath.x;
      // The baked weight carries no gradient to bend the normal with; at this drop the shading
      // error stays within a few degrees.
      y = y.sub(opening.mul(weight).mul(JAW_DROP * zLen));
    }
    const position = vec3(x, y, z.add(pectoralRow)).toVar('fishPosition');
    const slope = slopeS.div(-zLen).add(bendSlope);
    const normal = normalize(vec3(nx, ny, nz.sub(slope.mul(nx)))).toVar('fishNormal');
    return { position, normal };
  }

  setFeatures(features: FishMaterialFeatures): void {
    const { source, profile, lighting } = this.config;
    this.deformation = features.gills ? this.breathing : this.still;
    const look = this.instanceVec4(8);
    const tint = this.instanceVec4(12).xyz;
    const pale = look.y;
    const seed = look.z;
    const walker = this.config.locomotion.kind === 'walk';
    const fin = this.finMaskAndId();
    // A shrimp's limbs are its translucent membranes; its abdomen weight is the tail curl's.
    const membrane = walker
      ? step(LEG_PART_ID - 0.5, fin.y).mul(step(fin.y, 8.5))
      : step(0.5, fin.y);
    const finAmount = smoothstep(0.08, 0.5, fin.x).mul(membrane);

    const sample = source.map !== null ? texture(source.map) : vec4(1);
    const authored = sample.rgb.mul(color(source.color));
    const eye = keepsAuthoredSurface(source);
    const youth = this.instanceVec4(InstanceSlot.Youth - (InstanceSlot.Youth % 4)).w;
    const base = eye ? authored : juvenileLivery(authored.mul(tint), youth);
    const grey = vec3(luminance(base).mul(0.8).add(0.06));
    // Paling is chromatophores contracting in the skin, which an eye has none of; greying the
    // pupil would cloud it like a cataract instead.
    const paled = eye ? base : mix(base, grey, pale.mul(0.85));
    // Shrimp catch none of these diseases, and the cysts and dust sit on skin, not on the cornea.
    const signs = walker || eye ? null : this.instanceVec4(InstanceSlot.Ich).xyz;
    const marks =
      signs === null ? null : diseaseMarks(signs, fin.x, fin.y, membrane).toVar('diseaseMarks');
    const albedo = (
      signs !== null && marks !== null ? diseasedAlbedo(paled, marks, signs) : paled
    ).toVar();
    this.colorNode = albedo;
    // Dust is matte and hides the mucus gloss and the iridophores under it.
    const undusted = marks === null ? null : marks.y.oneMinus();
    this.roughnessNode =
      marks === null ? null : mix(materialRoughness, float(VELVET_ROUGHNESS), marks.y);

    const textureAlpha = sample.a.mul(source.opacity);
    const hasAlpha = source.transparent || source.alphaTest > 0;
    const authoredCutoff = source.alphaTest > 0;
    const silhouette = hasAlpha
      ? textureAlpha.greaterThan(authoredCutoff ? source.alphaTest : SILHOUETTE_ALPHA)
      : null;
    const translucent = features.fins !== 'cutout' && (hasAlpha || profile.finTransmission > 0);
    // BLEND models often carry half-transparent skin texels, so the body's source alpha is only a
    // silhouette. A fish's membranes keep their painted alpha from the root out, where the fin mask
    // is still near 0, and the fin mask thins it further towards the edge. A shrimp's alpha is one
    // flat value over the whole shell, so its limbs only thin by the mask: a solid stipple of a
    // flat alpha would dust every leg with holes from hip to tip.
    const bodyAlpha = smoothstep(0.02, 0.1, textureAlpha);
    const finAlpha = (walker ? bodyAlpha : textureAlpha).mul(
      float(1).sub(finAmount.mul(profile.finTransmission * (1 - FIN_OPACITY_FLOOR))),
    );
    const membraneCoverage = mix(bodyAlpha, finAlpha, membrane);
    // Ich cysts are opaque even on a clear fin.
    const coverage =
      marks === null
        ? membraneCoverage
        : mix(membraneCoverage, max(membraneCoverage, bodyAlpha), marks.x);
    const kept = marks?.z ?? null;
    this.alphaToCoverage = translucent && features.fins === 'coverage';
    // Every species with see-through membranes needs the dither, or its fins band into
    // COVERAGE_SAMPLES steps; the body is opaque or cut out, so it is left undithered. Rotted
    // membrane is cut after the dither, which would otherwise leave a stipple where it was.
    const dithered = mix(coverage, ditheredCoverage(coverage, seed), membrane);
    this.opacityNode = this.alphaToCoverage
      ? kept === null
        ? dithered
        : dithered.mul(kept)
      : null;
    if (translucent && features.fins === 'stochastic') {
      this.maskNode = screenDoor(kept === null ? coverage : coverage.mul(kept), seed);
    } else if (this.alphaToCoverage && hasAlpha && !authoredCutoff) {
      // Coverage fades a membrane out by itself; the skin keeps its hard cut.
      this.maskNode = textureAlpha.greaterThan(membrane.oneMinus().mul(SILHOUETTE_ALPHA));
    } else if (kept !== null && !this.alphaToCoverage) {
      const intact = kept.greaterThan(0.5);
      this.maskNode = silhouette === null ? intact : silhouette.and(intact);
    } else {
      this.maskNode = silhouette;
    }

    // A newborn's whole body is translucent, so every species glows past the cutout tier; an eye
    // keeps its authored surface.
    const fryBody = eye ? null : youth;
    if (features.fins !== 'cutout' && (profile.finTransmission > 0 || fryBody !== null)) {
      const toEye = normalize(cameraPosition.sub(positionWorld));
      const l = lighting.lightDirection;
      const diffuse = abs(dot(normalWorld, l)).mul(0.3);
      const forward = pow(max(dot(toEye, l.negate()), 0), 3).mul(0.7);
      const fins = finAmount.mul(profile.finTransmission);
      const share = fryBody === null ? fins : translucentShare(fins, fryBody);
      this.emissiveNode = albedo
        .mul(lighting.light)
        .mul(diffuse.add(forward))
        .mul(share.mul(1 / Math.PI));
    } else {
      this.emissiveNode = null;
    }

    const coat = mix(float(0.6), float(0.2), finAmount);
    this.clearcoatNode = features.clearcoat
      ? undusted === null
        ? coat
        : coat.mul(undusted)
      : null;
    this.clearcoat = 0;

    if (features.iridescence && profile.iridescence > 0) {
      const sampleRgb = sample.rgb;
      const where =
        profile.iridescenceMask === 'blue'
          ? smoothstep(0.02, 0.2, sampleRgb.b.sub(max(sampleRgb.r, sampleRgb.g)))
          : float(1);
      const iridescence = where
        .mul(finAmount.oneMinus())
        .mul(pale.mul(NIGHT_IRIDESCENCE_LOSS).oneMinus())
        .mul(youth.oneMinus())
        .mul(profile.iridescence);
      this.iridescenceNode = undusted === null ? iridescence : iridescence.mul(undusted);
      this.iridescenceThicknessNode = look.w.mul(pale.mul(NIGHT_PLATELET_SHRINK).oneMinus());
    } else {
      this.iridescenceNode = null;
      this.iridescenceThicknessNode = null;
    }
    this.needsUpdate = true;
  }

  /** The model-space vertex position and normal the current features draw with. */
  get deformed(): Readonly<Deformation> {
    return this.deformation;
  }

  override setupPosition(builder: NodeBuilder): Node {
    const { position, normal } = this.deformation;
    positionLocal.assign(position);
    // Motion vectors for the temporal resolve: the swimming wave is slow next to the instance motion.
    if (builder.needsPreviousData()) positionPrevious.assign(position);
    normalLocal.assign(normal);
    return super.setupPosition(builder);
  }
}
