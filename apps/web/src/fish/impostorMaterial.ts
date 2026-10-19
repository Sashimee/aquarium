import { MeshPhysicalNodeMaterial, type Node, type NodeBuilder } from 'three/webgpu';
import {
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  instancedDynamicBufferAttribute,
  length,
  log2,
  luminance,
  max,
  mix,
  normalize,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionPrevious,
  positionView,
  positionWorld,
  pow,
  select,
  smoothstep,
  sqrt,
  texture,
  varying,
  vec2,
  vec3,
  vec4,
  viewZToPerspectiveDepth,
} from 'three/tsl';
import { ImpostorSlot, type ImpostorAtlas, type ImpostorInstanceData } from './impostor';
import {
  bodyBend,
  diseasedAlbedo,
  distantDiseaseMarks,
  dustedRoughness,
  FIN_OPACITY_FLOOR,
  juvenileLivery,
  rotateByQuat,
  translucentShare,
  type FishLighting,
  type FishMaterialFeatures,
} from './material';
import { frameInset, maxFrameMip } from './octahedral';
import type { FishRenderProfile } from './profiles';
import type { SwimModeParams } from './swim';

export interface FishImpostorConfig {
  readonly assetId: string;
  readonly atlas: ImpostorAtlas;
  readonly profile: FishRenderProfile;
  readonly mode: SwimModeParams;
  /** Model-space z of the snout and of the tail tip. */
  readonly zMax: number;
  readonly zMin: number;
  readonly instances: ImpostorInstanceData;
  readonly lighting: FishLighting;
}

interface Basis {
  readonly right: Node<'vec3'>;
  readonly up: Node<'vec3'>;
}

const signNotZero = (x: Node<'float'>): Node<'float'> =>
  select(x.greaterThanEqual(0), float(1), float(-1));

/** `uvToDirection` of `octahedral.ts`. */
function uvToDirection(u: Node<'float'>, v: Node<'float'>): Node<'vec3'> {
  const x = u.mul(2).sub(1);
  const z = v.mul(2).sub(1);
  const y = float(1).sub(abs(x)).sub(abs(z));
  const folded = y.lessThan(0);
  const fx = float(1).sub(abs(z)).mul(signNotZero(x));
  const fz = float(1).sub(abs(x)).mul(signNotZero(z));
  return normalize(vec3(select(folded, fx, x), y, select(folded, fz, z)));
}

/** `viewBasis` of `octahedral.ts`; `toward` is `d` itself. */
function viewBasis(d: Node<'vec3'>): Basis {
  const reference = select(abs(d.y).greaterThan(1 - 1e-6), vec3(0, 0, 1), vec3(0, 1, 0));
  const right = normalize(cross(reference, d));
  return { right, up: cross(d, right) };
}

/**
 * The lod2 stand-in of a fish: a camera-facing strip that samples the species' octahedral atlas
 * (`tools/asset-pipeline/IMPOSTOR.md`), bent by the same body wave as the meshes and lit by
 * three's physical model from the baked normals, so it matches the mesh it replaces.
 *
 * The strip lies in the plane through the pivot facing the camera, with its long axis along the
 * fish's body as the camera sees it: then every cross-section of the strip sits at one model z and
 * takes the wave's lateral offset there. The atlas lookup uses the undeformed strip point, so the
 * picture rides along with the bend.
 */
export class FishImpostorMaterial extends MeshPhysicalNodeMaterial {
  private readonly position: Node<'vec3'>;
  /** Strip point relative to the pivot in model space (xyz), and the body slope there (w). */
  private readonly surface: Node<'vec4'>;
  private readonly config: FishImpostorConfig;
  private readonly instanceNodes = new Map<number, Node<'vec4'>>();

  constructor(config: FishImpostorConfig) {
    super();
    this.config = config;
    const { profile, atlas, mode, zMin, zMax } = config;
    const { pivot, radius } = atlas.info;
    this.name = `fish-impostor:${config.assetId}`;
    this.roughness = profile.roughness;
    this.metalness = 0;
    this.clearcoatRoughness = 0.08;

    const swim = this.instanceVec4(ImpostorSlot.Swim);
    const toCamera = this.instanceVec4(ImpostorSlot.View).xyz;
    const zProjected = vec3(0, 0, 1).sub(toCamera.mul(toCamera.z));
    // Head-on, the body has no on-screen axis; the strip's roll then changes nothing.
    const along = normalize(zProjected.add(viewBasis(toCamera).right.mul(1e-4)));
    const across = cross(toCamera, along);
    const q = along.mul(positionGeometry.x).add(across.mul(positionGeometry.y)).mul(radius);
    const p = q.add(vec3(...pivot)).toVar();
    const bend = bodyBend(mode, zMin, zMax, swim, p.z);
    this.position = vec3(p.x.add(bend.offset), p.y, p.z).toVar('impostorPosition');
    const slope = bend.slopeS.div(-(zMax - zMin)).add(bend.bendSlope);
    this.surface = varying(vec4(q, slope), 'impostorSurface');
    this.setFeatures({ fins: 'cutout', iridescence: false, clearcoat: true, gills: false });
  }

  private instanceVec4(offset: number): Node<'vec4'> {
    let node = this.instanceNodes.get(offset);
    if (node === undefined) {
      const { buffer, stride } = this.config.instances;
      node = instancedDynamicBufferAttribute(buffer, 'vec4', stride, offset);
      this.instanceNodes.set(offset, node);
    }
    return node;
  }

  setFeatures(features: FishMaterialFeatures): void {
    const { atlas, profile, lighting } = this.config;
    const { grid, frameSize, radius } = atlas.info;
    const maxMip = maxFrameMip(frameSize);
    const inset = frameInset(frameSize, maxMip);

    const orientation = this.instanceVec4(ImpostorSlot.Orientation);
    const scale = this.instanceVec4(ImpostorSlot.Swim).x;
    const view = this.instanceVec4(ImpostorSlot.View);
    const toCamera = view.xyz;
    const pale = view.w;
    const tintBlock = this.instanceVec4(ImpostorSlot.Tint);
    const tint = tintBlock.xyz;
    const youth = tintBlock.w;
    const frames = this.instanceVec4(ImpostorSlot.Frames);
    const q = this.surface.xyz;
    const slope = this.surface.w;

    const footprint = max(length(dFdx(q)), length(dFdy(q))).mul(frameSize / (2 * radius));
    const level = clamp(log2(max(footprint, 1e-6)), 0, maxMip);

    let colour: Node<'vec4'> = vec4(0);
    let surface: Node<'vec4'> = vec4(0);
    let normal: Node<'vec3'> = vec3(0);
    const corners = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const;
    for (const [di, dj] of corners) {
      const i = frames.x.add(di);
      const j = frames.y.add(dj);
      const wx = di === 0 ? frames.z.oneMinus() : frames.z;
      const wy = dj === 0 ? frames.w.oneMinus() : frames.w;
      const weight = wx.mul(wy);
      const d = uvToDirection(i.div(grid - 1), j.div(grid - 1));
      const { right, up } = viewBasis(d);
      // `framePointUv`: the view ray through q meets this frame's plane, seen in its own basis.
      const t = dot(q, d).div(max(dot(toCamera, d), 0.25));
      const x = q.sub(toCamera.mul(t));
      const lu = clamp(
        dot(x, right)
          .mul(0.5 / radius)
          .add(0.5),
        inset,
        1 - inset,
      );
      const lv = clamp(float(0.5).sub(dot(x, up).mul(0.5 / radius)), inset, 1 - inset);
      const uv = vec2(i.add(lu), j.add(lv)).div(grid);
      const albedo = texture(atlas.albedo, uv, level);
      const stored = texture(atlas.normal, uv, level);
      const nx = stored.x.mul(2).sub(1);
      const ny = stored.y.mul(2).sub(1);
      const nz = sqrt(max(float(1).sub(nx.mul(nx)).sub(ny.mul(ny)), 0));
      colour = colour.add(albedo.mul(weight));
      surface = surface.add(stored.mul(weight));
      normal = normal.add(right.mul(nx).add(up.mul(ny)).add(d.mul(nz)).mul(weight));
    }
    const coverage = colour.a;
    const finMask = surface.z;
    const depth = surface.w;

    // The mesh's normal under the wave: n_z -= x'(z) n_x, as in FishMaterial.
    const bent = vec3(normal.x, normal.y, normal.z.sub(slope.mul(normal.x)));
    const world = rotateByQuat(orientation, normalize(bent));
    const viewNormal = normalize(cameraViewMatrix.mul(vec4(world, 0)).xyz).toVar('impostorNormal');
    this.normalNode = viewNormal;
    // Without a map the clearcoat would take the flat strip's own normal.
    this.clearcoatNormalNode = viewNormal;

    const finAmount = smoothstep(0.08, 0.5, finMask);
    const signs = this.instanceVec4(ImpostorSlot.Illness).xyz;
    const marks = distantDiseaseMarks(signs, finMask, finAmount).toVar('impostorDiseaseMarks');
    const base = juvenileLivery(colour.rgb.mul(tint), youth);
    const grey = vec3(luminance(base).mul(0.8).add(0.06));
    const albedo = diseasedAlbedo(mix(base, grey, pale.mul(0.85)), marks, signs).toVar();
    this.colorNode = albedo;
    this.roughnessNode = dustedRoughness(marks);

    const translucent = features.fins !== 'cutout' && profile.finTransmission > 0;
    const glows = features.fins !== 'cutout';
    const finAlpha = coverage.mul(
      float(1).sub(finAmount.mul(profile.finTransmission * (1 - FIN_OPACITY_FLOOR))),
    );
    // Ich cysts are opaque even on a clear fin, as on the mesh.
    const membraneAlpha = mix(finAlpha, coverage, marks.x);
    const kept = marks.z;
    this.alphaToCoverage = features.fins === 'coverage';
    if (this.alphaToCoverage) {
      this.opacityNode = (translucent ? membraneAlpha : coverage).mul(kept);
      this.maskNode = coverage.greaterThan(0.02);
    } else {
      this.opacityNode = null;
      this.maskNode = coverage.greaterThan(0.5).and(kept.greaterThan(0.5));
    }

    if (glows) {
      const toEye = normalize(cameraPosition.sub(positionWorld));
      const l = lighting.lightDirection;
      const diffuse = abs(dot(normalWorld, l)).mul(0.3);
      const forward = pow(max(dot(toEye, l.negate()), 0), 3).mul(0.7);
      const share = translucentShare(finAmount.mul(profile.finTransmission), youth);
      this.emissiveNode = albedo
        .mul(lighting.light)
        .mul(diffuse.add(forward))
        .mul(share.mul(1 / Math.PI));
    } else {
      this.emissiveNode = null;
    }
    this.clearcoatNode = features.clearcoat
      ? mix(float(0.6), float(0.2), finAmount).mul(marks.y.oneMinus())
      : null;
    this.clearcoat = 0;

    // The strip runs through the pivot; push each fragment out to the baked surface, so the fish
    // sorts against decor as its mesh does.
    const towardCamera = depth
      .sub(0.5)
      .mul(2 * radius)
      .mul(scale);
    const viewZ = positionView.z.mul(float(1).sub(towardCamera.div(length(positionView))));
    this.depthNode = viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar);
    this.needsUpdate = true;
  }

  override setupPosition(builder: NodeBuilder): Node {
    positionLocal.assign(this.position);
    if (builder.needsPreviousData()) positionPrevious.assign(this.position);
    return super.setupPosition(builder);
  }
}
