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
  attribute,
  cameraPosition,
  clamp,
  color,
  cos,
  cross,
  dot,
  float,
  frameId,
  instancedDynamicBufferAttribute,
  interleavedGradientNoise,
  luminance,
  max,
  min,
  mix,
  normalGeometry,
  normalize,
  normalLocal,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionPrevious,
  positionWorld,
  pow,
  screenCoordinate,
  sign,
  sin,
  smoothstep,
  step,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { FIN_ATTRIBUTE } from './assets';
import { INSTANCE_STRIDE, type FishInstanceData } from './instances';
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
  /** Opercular pumping in the vertex deformation. */
  readonly gills: boolean;
}

export interface FishMaterialConfig {
  readonly source: MeshStandardMaterial;
  /** The model the material draws, which may be the profile's male one. */
  readonly assetId: string;
  readonly profile: FishRenderProfile;
  readonly mode: SwimModeParams;
  /** Model-space z of the snout and of the tail tip. */
  readonly zMax: number;
  readonly zMin: number;
  readonly instances: FishInstanceData;
  readonly lighting: FishLighting;
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
/** Guanine (n ≈ 1.83) platelets are the reflectors in fish iridophores (Land 1972). */
const GUANINE_IOR = 1.83;
const FIN_OPACITY_FLOOR = 0.2;
/**
 * A resting or stressed fish tilts its iridophore platelets closer together: the reflection dims
 * and shifts towards violet, as the neon tetra's stripe does at night (Yoshioka et al. 2011).
 */
const NIGHT_IRIDESCENCE_LOSS = 0.5;
const NIGHT_PLATELET_SHRINK = 0.12;
/** Below this alpha a texel is outside the fin silhouette in every mode. */
const SILHOUETTE_ALPHA = 0.1;
/** `antialias: true` gives four MSAA samples on both backends. */
const COVERAGE_SAMPLES = 4;
/** Golden-ratio-like step that decorrelates consecutive frames of the noise (Jimenez 2014). */
const FRAME_NOISE_STEP = 5.588238;

interface Deformation {
  readonly position: Node<'vec3'>;
  readonly normal: Node<'vec3'>;
}

function idIs(id: Node<'float'>, value: number): Node<'float'> {
  return step(value - 0.5, id).mul(step(id, value + 0.5));
}

/** smoothstep(a, b, x) and its derivative in x. */
function smoothRamp(a: number, b: number, x: Node<'float'>): [Node<'float'>, Node<'float'>] {
  const t = clamp(x.sub(a).div(b - a), 0, 1);
  return [t.mul(t).mul(t.mul(-2).add(3)), t.mul(t.oneMinus()).mul(6 / (b - a))];
}

function rotateByQuat(q: Node<'vec4'>, v: Node<'vec3'>): Node<'vec3'> {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
}

/**
 * A pixel survives when its alpha beats interleaved gradient noise (Jimenez 2014). The pattern
 * moves every frame so a temporal resolve averages it into a blend; without one it is raw stipple.
 * The per-fish offset keeps two overlapping fins from sharing a pattern.
 */
function screenDoor(alpha: Node<'float'>, seed: Node<'float'>): Node<'bool'> {
  const frame = float(frameId).mod(64).mul(FRAME_NOISE_STEP);
  const pixel = screenCoordinate.xy.add(vec2(seed.mul(61.3), seed.mul(29.7)).floor()).add(frame);
  return alpha.greaterThan(interleavedGradientNoise(pixel));
}

/**
 * Alpha-to-coverage keeps only COVERAGE_SAMPLES + 1 levels, so a soft membrane edge would band and
 * its faint rim would round to nothing. A fixed per-pixel offset of up to one sample step dithers
 * between neighbouring levels, which the MSAA resolve averages back into a gradient. The offset
 * shrinks to zero towards alpha 1, so opaque skin keeps every sample.
 */
function ditheredCoverage(alpha: Node<'float'>, seed: Node<'float'>): Node<'float'> {
  const pixel = screenCoordinate.xy.add(vec2(seed.mul(61.3), seed.mul(29.7)).floor());
  const reach = min(alpha.oneMinus().mul(2), 1 / COVERAGE_SAMPLES);
  return alpha.add(interleavedGradientNoise(pixel).sub(0.5).mul(reach));
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
    this.roughness = profile.roughness;
    this.metalness = 0;
    this.normalMap = source.normalMap;
    this.normalScale.copy(source.normalScale);
    this.clearcoatRoughness = 0.08;
    this.iridescenceIOR = GUANINE_IOR;

    this.still = this.buildDeformation(false);
    this.breathing = this.buildDeformation(true);
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
        INSTANCE_STRIDE,
        offset,
      );
      this.instanceNodes.set(offset, node);
    }
    return node;
  }

  private buildDeformation(gills: boolean): Deformation {
    const { mode, zMax, zMin } = this.config;
    const zLen = zMax - zMin;
    const [c0, c1, c2] = mode.envelope;
    const k = (2 * Math.PI) / mode.wavelength;
    const swim = this.instanceVec4(4);
    const look = this.instanceVec4(8);
    const phase = swim.y;
    const amp = swim.z;
    const curvature = swim.w;
    const finPhase = look.x;
    const fin = attribute<'vec2'>(FIN_ATTRIBUTE, 'vec2');
    const mask = fin.x;
    const id = fin.y;
    const p = positionGeometry;

    const s = clamp(float(zMax).sub(p.z).div(zLen), 0, 1).toVar();
    const envelope = float(c0).add(s.mul(c1)).add(s.mul(s).mul(c2));
    const envelopeSlope = float(c1).add(s.mul(2 * c2));
    const arg = s.mul(k).sub(phase).toVar();
    const bodyAmplitude = amp.mul((TAIL_AMPLITUDE_BODY_LENGTHS / 2) * zLen * mode.bodyWave);
    const body = bodyAmplitude.mul(envelope).mul(sin(arg));
    const bodySlopeS = bodyAmplitude.mul(
      envelopeSlope.mul(sin(arg)).add(envelope.mul(k).mul(cos(arg))),
    );

    const headSide = step(0, p.z);
    const bendWeight = mix(float(1), float(HEAD_BEND), headSide);
    const bend = curvature.mul(0.5).mul(p.z).mul(p.z).mul(bendWeight);
    const bendSlope = curvature.mul(p.z).mul(bendWeight);

    const side = sign(p.x);
    const caudal = idIs(id, FIN_ID.caudal)
      .mul(mask.mul(mask))
      .mul(amp.mul(CAUDAL_LAG * zLen))
      .mul(sin(arg.sub(CAUDAL_LAG_PHASE)));
    const median = idIs(id, FIN_ID.dorsal)
      .add(idIs(id, FIN_ID.anal))
      .mul(mask)
      .mul(mode.medianFin * zLen)
      .mul(sin(s.mul(k * 1.5).sub(finPhase)))
      .mul(amp.mul(0.5).add(0.5));
    const pectoral = idIs(id, FIN_ID.pectoral)
      .mul(mask)
      .mul(mode.pectoral * zLen);
    const pectoralOut = pectoral.mul(side).mul(sin(finPhase).mul(0.5).add(0.5));
    const pectoralRow = pectoral.mul(0.6).mul(cos(finPhase));
    const pelvic = idIs(id, FIN_ID.pelvic)
      .mul(mask)
      .mul(side)
      .mul(PELVIC_AMPLITUDE * zLen)
      .mul(sin(finPhase.add(1)));

    const dx = body.add(bend).add(caudal).add(median).add(pectoralOut).add(pelvic);
    const n = normalGeometry;
    let x: Node<'float'> = p.x.add(dx);
    let nx: Node<'float'> = n.x;
    // x' = x·(1 + g(z)) + h(z); normals transform by the inverse transpose of its Jacobian:
    // n_x /= 1 + g, then n_z -= (x·g'(z) + h'(z))·n_x.
    let slopeS: Node<'float'> = bodySlopeS;
    if (gills) {
      const opening = this.instanceVec4(12).w;
      const [cover, coverSlope] = smoothRamp(GILL_EDGE_S - GILL_COVER_S, GILL_EDGE_S, s);
      const [behind, behindSlope] = smoothRamp(GILL_EDGE_S, GILL_EDGE_S + GILL_FALLOFF_S, s);
      const flare = opening.mul(GILL_FLARE).mul(smoothstep(0.08, 0.5, mask).oneMinus());
      const widen = flare.mul(cover).mul(behind.oneMinus()).add(1).toVar();
      const widenSlopeS = flare.mul(coverSlope.mul(behind.oneMinus()).sub(cover.mul(behindSlope)));
      x = p.x.mul(widen).add(dx);
      nx = n.x.div(widen);
      slopeS = slopeS.add(p.x.mul(widenSlopeS));
    }
    const position = vec3(x, p.y, p.z.add(pectoralRow)).toVar('fishPosition');
    const slope = slopeS.div(-zLen).add(bendSlope);
    const normal = normalize(vec3(nx, n.y, n.z.sub(slope.mul(nx)))).toVar('fishNormal');
    return { position, normal };
  }

  setFeatures(features: FishMaterialFeatures): void {
    const { source, profile, lighting } = this.config;
    this.deformation = features.gills ? this.breathing : this.still;
    const look = this.instanceVec4(8);
    const tint = this.instanceVec4(12).xyz;
    const pale = look.y;
    const seed = look.z;
    const fin = attribute<'vec2'>(FIN_ATTRIBUTE, 'vec2');
    const finAmount = smoothstep(0.08, 0.5, fin.x);

    const sample = source.map !== null ? texture(source.map) : vec4(1);
    const base = sample.rgb.mul(color(source.color)).mul(tint);
    const grey = vec3(luminance(base).mul(0.8).add(0.06));
    const albedo = mix(base, grey, pale.mul(0.85)).toVar();
    this.colorNode = albedo;

    const textureAlpha = sample.a.mul(source.opacity);
    const hasAlpha = source.transparent || source.alphaTest > 0;
    const authoredCutoff = source.alphaTest > 0;
    const silhouette = hasAlpha
      ? textureAlpha.greaterThan(authoredCutoff ? source.alphaTest : SILHOUETTE_ALPHA)
      : null;
    const translucent = features.fins !== 'cutout' && (hasAlpha || profile.finTransmission > 0);
    // Source alpha is only trusted as coverage on the body, where BLEND models often carry
    // half-transparent skin texels; the membrane look comes from the fin mask.
    const bodyAlpha = smoothstep(0.02, 0.1, textureAlpha);
    const finAlpha = textureAlpha.mul(
      float(1).sub(finAmount.mul(profile.finTransmission * (1 - FIN_OPACITY_FLOOR))),
    );
    const coverage = mix(bodyAlpha, finAlpha, finAmount);
    this.alphaToCoverage = translucent && features.fins === 'coverage';
    this.opacityNode = this.alphaToCoverage ? ditheredCoverage(coverage, seed) : null;
    if (translucent && features.fins === 'stochastic') {
      this.maskNode = screenDoor(coverage, seed);
    } else if (this.alphaToCoverage && hasAlpha && !authoredCutoff) {
      // Coverage fades a membrane rim out by itself; the skin keeps its hard cut.
      this.maskNode = textureAlpha.greaterThan(finAmount.oneMinus().mul(SILHOUETTE_ALPHA));
    } else {
      this.maskNode = silhouette;
    }

    if (features.fins !== 'cutout' && profile.finTransmission > 0) {
      const toEye = normalize(cameraPosition.sub(positionWorld));
      const l = lighting.lightDirection;
      const diffuse = abs(dot(normalWorld, l)).mul(0.3);
      const forward = pow(max(dot(toEye, l.negate()), 0), 3).mul(0.7);
      this.emissiveNode = albedo
        .mul(lighting.light)
        .mul(diffuse.add(forward))
        .mul(finAmount.mul(profile.finTransmission / Math.PI));
    } else {
      this.emissiveNode = null;
    }

    this.clearcoatNode = features.clearcoat ? mix(float(0.6), float(0.2), finAmount) : null;
    this.clearcoat = 0;

    if (features.iridescence && profile.iridescence > 0) {
      const sampleRgb = sample.rgb;
      const where =
        profile.iridescenceMask === 'blue'
          ? smoothstep(0.02, 0.2, sampleRgb.b.sub(max(sampleRgb.r, sampleRgb.g)))
          : float(1);
      this.iridescenceNode = where
        .mul(finAmount.oneMinus())
        .mul(pale.mul(NIGHT_IRIDESCENCE_LOSS).oneMinus())
        .mul(profile.iridescence);
      this.iridescenceThicknessNode = look.w.mul(pale.mul(NIGHT_PLATELET_SHRINK).oneMinus());
    } else {
      this.iridescenceNode = null;
      this.iridescenceThicknessNode = null;
    }
    this.needsUpdate = true;
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
