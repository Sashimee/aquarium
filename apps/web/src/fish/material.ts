import {
  Color,
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
  mix,
  normalGeometry,
  normalize,
  normalLocal,
  normalWorld,
  positionGeometry,
  positionLocal,
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
  readonly lightRadiance: UniformNode<'color', Color>;
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
}

export interface FishMaterialConfig {
  readonly source: MeshStandardMaterial;
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
/** Guanine (n ≈ 1.83) platelets are the reflectors in fish iridophores (Land 1972). */
const GUANINE_IOR = 1.83;
const FIN_OPACITY_FLOOR = 0.2;
/** Below this alpha a texel is outside the fin silhouette in every mode. */
const SILHOUETTE_ALPHA = 0.1;
/** Golden-ratio-like step that decorrelates consecutive frames of the noise (Jimenez 2014). */
const FRAME_NOISE_STEP = 5.588238;

function idIs(id: Node<'float'>, value: number): Node<'float'> {
  return step(value - 0.5, id).mul(step(id, value + 0.5));
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
 * Fish skin and fins on top of three's physical model, with the swimming deformation applied in
 * model space before instancing, so every instance shares one mesh.
 */
export class FishMaterial extends MeshPhysicalNodeMaterial {
  readonly deformedPosition: Node<'vec3'>;
  private readonly deformedNormal: Node<'vec3'>;
  private readonly config: FishMaterialConfig;
  private readonly instanceNodes = new Map<number, Node<'vec4'>>();

  constructor(config: FishMaterialConfig) {
    super();
    this.config = config;
    const { source, profile } = config;
    this.name = `fish:${profile.assetId}:${source.name}`;
    this.side = DoubleSide;
    this.roughness = profile.roughness;
    this.metalness = 0;
    this.normalMap = source.normalMap;
    this.normalScale.copy(source.normalScale);
    this.clearcoatRoughness = 0.08;
    this.iridescenceIOR = GUANINE_IOR;

    const { position, normal } = this.buildDeformation();
    this.deformedPosition = position;
    this.deformedNormal = normal;

    const orientation = this.instanceVec4(0);
    const scale = this.instanceVec4(4).x;
    // The shadow pass uses a plain override material that instances the undeformed geometry.
    this.castShadowPositionNode = positionLocal.add(
      rotateByQuat(orientation, position.sub(positionGeometry).mul(scale)),
    );
    this.setFeatures({ fins: 'coverage', iridescence: true, clearcoat: true });
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

  private buildDeformation(): { position: Node<'vec3'>; normal: Node<'vec3'> } {
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
    const position = vec3(p.x.add(dx), p.y, p.z.add(pectoralRow)).toVar('fishPosition');

    // x' = x + h(z) is a shear; normals transform by its inverse transpose: n_z -= h'(z)·n_x.
    const slope = bodySlopeS.div(-zLen).add(bendSlope);
    const n = normalGeometry;
    const normal = normalize(vec3(n.x, n.y, n.z.sub(slope.mul(n.x)))).toVar('fishNormal');
    return { position, normal };
  }

  setFeatures(features: FishMaterialFeatures): void {
    const { source, profile, lighting } = this.config;
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
    const silhouette = hasAlpha
      ? textureAlpha.greaterThan(source.alphaTest > 0 ? source.alphaTest : SILHOUETTE_ALPHA)
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
    this.opacityNode = this.alphaToCoverage ? coverage : null;
    this.maskNode =
      translucent && features.fins === 'stochastic' ? screenDoor(coverage, seed) : silhouette;

    if (features.fins !== 'cutout' && profile.finTransmission > 0) {
      const toEye = normalize(cameraPosition.sub(positionWorld));
      const l = lighting.lightDirection;
      const diffuse = abs(dot(normalWorld, l)).mul(0.3);
      const forward = pow(max(dot(toEye, l.negate()), 0), 3).mul(0.7);
      this.emissiveNode = albedo
        .mul(lighting.lightRadiance)
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
        .mul(pale.oneMinus())
        .mul(profile.iridescence);
      this.iridescenceThicknessNode = look.w;
    } else {
      this.iridescenceNode = null;
      this.iridescenceThicknessNode = null;
    }
    this.needsUpdate = true;
  }

  override setupPosition(builder: NodeBuilder): Node {
    positionLocal.assign(this.deformedPosition);
    normalLocal.assign(this.deformedNormal);
    return super.setupPosition(builder);
  }
}
