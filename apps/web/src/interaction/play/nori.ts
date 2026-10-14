import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  attribute,
  clamp,
  faceDirection,
  float,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionLocal,
  select,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  uv,
  vec3,
} from 'three/tsl';
import { FOOD_PROFILES } from '../food/profiles';

/** Sheet height in radii; the sheet spans x in [-1, 1] and hangs from the clip at y = 0. */
export const SHEET_LENGTH = 1.6;
/** How far the clip's jaws reach past the sheet's plane when it lies flat, in radii. */
const CLIP_LIFT = 0.06;
const SHEET_COLUMNS = 18;
const SHEET_ROWS = 14;
const PART_SHEET = 0;
const PART_CLIP = 1;
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

function tagged(geometry: BufferGeometry, part: number): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('part', new Float32BufferAttribute(new Float32Array(count).fill(part), 1));
  return geometry;
}

function sheetGeometry(): BufferGeometry {
  const plane = new PlaneGeometry(2, SHEET_LENGTH, SHEET_COLUMNS, SHEET_ROWS);
  plane.translate(0, -SHEET_LENGTH / 2, 0);
  return tagged(plane, PART_SHEET);
}

function clipGeometry(): BufferGeometry {
  const frontJaw = new BoxGeometry(0.26, 0.1, 0.035).translate(0, -0.01, 0.03);
  const backJaw = new BoxGeometry(0.26, 0.1, 0.035).translate(0, -0.01, -0.03);
  const arm = new BoxGeometry(0.08, 0.06, 0.16).translate(0, 0.04, -0.08);
  const cup = new CylinderGeometry(0.04, 0.13, 0.05, 20, 1, true)
    .rotateX(Math.PI / 2)
    .translate(0, 0.04, -0.17);
  const parts = [frontJaw, backJaw, arm, cup].map((g) => tagged(g, PART_CLIP));
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

/** One draw call's worth of geometry: the sheet grid plus the suction clip, in units of the sheet's half width. */
export function buildNoriGeometry(): BufferGeometry {
  const sheet = sheetGeometry();
  const clip = clipGeometry();
  const merged = mergeGeometries([sheet, clip]);
  sheet.dispose();
  clip.dispose();
  return merged;
}

/** Radians the sheet has swung from hanging (0) toward lying flat (pi/2) at `height` above the sand. */
export function hangAngle(height: number, scale: number): number {
  const length = SHEET_LENGTH * scale;
  if (!(height < length)) return 0;
  return Math.acos(Math.max(0, height) / length);
}

/** Stable 0..1 hash of a particle id. */
export function noriSeed(id: number): number {
  const s = Math.sin(id * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function buildMaterial(): MeshStandardNodeMaterial {
  const part = attribute('part', 'float');
  const data = attribute('noriData', 'vec4');
  const loss = data.x;
  const seed = data.y;
  const hang = data.z;
  const isClip = part.greaterThan(0.5);

  const coord = uv();
  const along = coord.y;
  const far = float(1).sub(along);
  const salt = seed.mul(37);
  const at = (scale: number, ox: number, oy: number) =>
    vec3(coord.x.mul(2 * scale).add(ox), coord.y.mul(SHEET_LENGTH * scale).add(oy), salt);
  const crinkle = (p: ReturnType<typeof at>) =>
    mx_noise_float(p.mul(2.6))
      .mul(0.7)
      .add(mx_noise_float(p.mul(5.7)).mul(0.3));

  const height = crinkle(at(1, 0, 0));
  const coarse = mx_noise_float(at(1, 0, 0).mul(2.6))
    .mul(0.6)
    .add(mx_noise_float(at(1, 0, 0).mul(5.7)).mul(0.4));
  const flutter = sin(time.mul(1.6).add(seed.mul(20)).add(far.mul(2.4)))
    .mul(0.06)
    .mul(hang)
    .mul(far.mul(far));
  const lift = coarse.mul(0.02).add(flutter);
  const displaced = positionLocal.add(vec3(0, 0, lift));

  const edgeNoise = mx_noise_float(at(0.75, 4, 9)).mul(0.5);
  const sideDistance = min(coord.x, float(1).sub(coord.x)).mul(2);
  const outline = min(sideDistance, along.mul(1.25)).add(edgeNoise.mul(0.2)).sub(0.05);
  const bite = mx_noise_float(at(1.7, 13, 5))
    .mul(0.5)
    .add(0.5)
    .mul(0.2)
    .add(far);
  const threshold = float(1.05).sub(loss);
  const inside = min(outline, threshold.sub(bite).mul(1.6));
  const pinholes = smoothstep(
    0.86,
    0.9,
    mx_noise_float(at(9, 3, 8))
      .mul(0.5)
      .add(0.5),
  ).mul(0.5);
  const sheetAlpha = smoothstep(0.0, 0.03, inside.sub(pinholes));
  const thin = float(1).sub(smoothstep(0.0, 0.07, inside));

  const mottle = mx_noise_float(at(2.2, 7, 1))
    .mul(0.5)
    .add(0.5);
  const fibre = mx_noise_float(vec3(coord.x.mul(46).add(salt), coord.y.mul(4), seed.mul(5)))
    .mul(0.5)
    .add(0.5);
  const body = mix(vec3(0.012, 0.04, 0.009), vec3(0.028, 0.07, 0.014), mottle);
  const veined = body.mul(float(0.85).add(fibre.mul(0.3)));
  const glow = clamp(thin.mul(0.85).add(mottle.sub(0.62).mul(0.5).max(0)), 0, 1);
  const sheetColor = mix(veined, vec3(0.1, 0.16, 0.03), glow);

  const slopeX = crinkle(at(1, 0.012, 0)).sub(height);
  const slopeY = crinkle(at(1, 0, 0.012)).sub(height);
  const crinkled = normalize(vec3(slopeX.mul(-2.5), slopeY.mul(-2.5), 0.55));
  const viewNormal = transformNormalToView(select(isClip, vec3(0, 0, 1), crinkled)).mul(
    faceDirection,
  );

  const material = new MeshStandardNodeMaterial({
    metalness: 0,
    alphaTest: 0.5,
    alphaToCoverage: true,
    side: DoubleSide,
  });
  material.positionNode = select(isClip, positionLocal, displaced);
  material.colorNode = select(isClip, vec3(0.05, 0.2, 0.1), sheetColor);
  material.opacityNode = select(isClip, float(1), sheetAlpha);
  material.roughnessNode = select(isClip, float(0.15), float(0.62).add(fibre.mul(0.2)));
  material.emissiveNode = select(
    isClip,
    vec3(0),
    vec3(0.012, 0.03, 0.006).add(vec3(0.03, 0.06, 0.012).mul(thin)),
  );
  material.normalNode = viewNormal;
  return material;
}

export interface NoriState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Fraction of the sheet bitten away, 0..1. */
  readonly eaten: number;
  /** Fraction left once dissolving, 1 until it starts. */
  readonly remaining: number;
  /** Sand height below the sheet. */
  readonly ground: number;
}

/** The nori sheets and their clips: one instanced mesh, torn and crinkled in the shader. */
export class NoriLayer {
  readonly mesh: InstancedMesh;
  private readonly data: InstancedBufferAttribute;
  private readonly material: MeshStandardNodeMaterial;
  private readonly geometry: BufferGeometry;
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly yaw = new Quaternion();
  private readonly swing = new Quaternion();
  private readonly orientation = new Quaternion();

  constructor(capacity: number) {
    this.geometry = buildNoriGeometry();
    this.data = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.geometry.setAttribute('noriData', this.data);
    this.material = buildMaterial();
    this.mesh = new InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  set(slot: number, state: NoriState): void {
    const seed = noriSeed(state.id);
    const scale = FOOD_PROFILES.nori.radius * (0.85 + 0.3 * noriSeed(state.id + 101));
    const angle = hangAngle(state.y - state.ground, scale);
    this.yaw.setFromAxisAngle(Y_AXIS, (seed - 0.5) * 0.4 + Math.sin(angle) * seed * Math.PI * 2);
    this.swing.setFromAxisAngle(X_AXIS, angle);
    this.orientation.multiplyQuaternions(this.yaw, this.swing);
    this.position.set(state.x, state.y + scale * CLIP_LIFT * Math.sin(angle), state.z);
    this.scale.setScalar(scale);
    this.matrix.compose(this.position, this.orientation, this.scale);
    this.mesh.setMatrixAt(slot, this.matrix);
    const o = slot * 4;
    const array = this.data.array as Float32Array;
    array[o] = Math.min(1, Math.max(state.eaten, 1 - state.remaining));
    array[o + 1] = seed;
    array[o + 2] = Math.cos(angle);
  }

  commit(count: number): void {
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    if (count === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.data.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
