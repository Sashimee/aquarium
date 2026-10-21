import {
  Color,
  DoubleSide,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type MeshStandardMaterial,
} from 'three/webgpu';
import {
  float,
  fract,
  instanceIndex,
  instancedBufferAttribute,
  positionGeometry,
  positionLocal,
  sin,
  vec3,
} from 'three/tsl';
import {
  FLUTTER_HZ,
  limitLean,
  limitLeanNode,
  normaliseDirection,
  PUMP_LEAN_HEIGHT,
  MEANDER_AMPLITUDE,
  type CurrentField,
  type CurrentParameters,
} from './current';
import type { LoadedModel } from './assets';
import type { PlantInstance } from './placement';

/** Seconds of current a leaf tip leans into; the bend grows with the square of the height. */
const SWAY_SECONDS = 1.2;
const FLUTTER_METRES = 0.004;

/** How much each species yields to the current: carpets and ferns hold still, ribbons stream. */
const STIFFNESS: Readonly<Record<string, number>> = {
  vallisneria: 1.15,
  'water-plant': 1,
  'pond-weed': 1,
  'universal-plant': 0.8,
  'red-tiger-lotus': 0.55,
  'java-fern': 0.45,
  'staurogyne-repens': 0.35,
};

/** Gap kept between the tallest leaf tip and the water surface, which ripples. */
export const SURFACE_MARGIN = 0.03;

/**
 * Largest scale at which a plant rooted at `rootY` keeps its highest leaf `SURFACE_MARGIN` under
 * `waterTop`. The shader adds its lean after the instance transform, so it is horizontal in tank
 * space and never raises a leaf; the tip stays at `rootY + scale * height * cos(tilt)`, and
 * `height` bounds that.
 */
export function surfaceScaleCeiling(waterTop: number, height: number): (rootY: number) => number {
  return (rootY) => Math.max(0, (waterTop - SURFACE_MARGIN - rootY) / Math.max(height, 1e-3));
}

/** Seconds of current a leaf tip of a plant this tall leans into, before the bend curve. */
export function leanSeconds(assetId: string, height: number): number {
  return SWAY_SECONDS * swayGain(assetId) * (height / 0.3);
}

export interface PlantEntry extends PlantInstance {
  /** Position in the patch's thinning order, 0 first to 1 last; layout plants use -1. */
  readonly rank: number;
}

/**
 * Furthest a plant of unit scale and the given height leans, bounded over the whole gust cycle.
 * With an `axis`, only the part of the lean that lands on that tank axis: flow runs along
 * `current.direction` and the meander across it, so a current along x barely reaches towards z.
 */
export function maxSway(
  assetId: string,
  height: number,
  current: CurrentParameters,
  axis?: 'x' | 'z',
): number {
  const forward = current.speed * (1 + current.gustDepth);
  const sideways = current.speed * current.gustDepth * MEANDER_AMPLITUDE;
  const [dx, dz] = normaliseDirection(current.direction);
  const along = axis === 'x' ? Math.abs(dx) : Math.abs(dz);
  const across = axis === 'x' ? Math.abs(dz) : Math.abs(dx);
  const pumpMps = current.pumpMps ?? 0;
  const ambientFlow = Math.hypot(forward, sideways);
  const seconds = leanSeconds(assetId, height);
  const lean = limitLean(
    (ambientFlow + pumpMps) * seconds,
    ambientFlow * seconds,
    PUMP_LEAN_HEIGHT * height,
  );
  if (axis === undefined) return lean + FLUTTER_METRES * 1.6;
  const axisFlow = forward * along + sideways * across + pumpMps;
  return Math.min(axisFlow * seconds, lean) + FLUTTER_METRES * 1.6;
}

/** Number of entries shown at `density`: those whose thinning rank is below it; layout plants (-1) always show. */
export function visibleAtDensity(entries: readonly { readonly rank: number }[], density: number) {
  let count = 0;
  for (const entry of entries) if (entry.rank < density) count++;
  return count;
}

export function swayGain(assetId: string): number {
  return STIFFNESS[assetId] ?? 0.8;
}

function createSwayMaterial(
  source: MeshStandardMaterial,
  geometry: BufferGeometry,
  assetId: string,
  current: CurrentField,
  pumpAttribute: InstancedBufferAttribute,
): MeshStandardNodeMaterial {
  geometry.computeBoundingBox();
  const height = Math.max(geometry.boundingBox?.max.y ?? 0.1, 0.02);

  const material = new MeshStandardNodeMaterial();
  material.name = `${source.name || 'plant'}-sway`;
  material.color.copy(source.color);
  material.map = source.map;
  material.normalMap = source.normalMap;
  material.normalScale.copy(source.normalScale);
  material.alphaTest = source.alphaTest;
  material.transparent = source.transparent;
  material.roughness = Math.max(source.roughness, 0.55);
  material.metalness = 0;
  material.side = DoubleSide;

  const stem = positionGeometry.y.div(height).clamp(0, 1);
  const bend = stem.mul(stem);
  // Bound per group, not set on the geometry: ModelLibrary shares one geometry between groups.
  const pump = instancedBufferAttribute<'vec2'>(pumpAttribute, 'vec2');
  const flow = current
    .velocityNode(positionLocal)
    .add(current.pumpVelocity(vec3(pump.x, 0, pump.y)));
  const phase = fract(sin(float(instanceIndex).mul(12.9898)).mul(43758.5453));
  const flutter = sin(
    current.flutterElapsed
      .mul(FLUTTER_HZ * Math.PI * 2)
      .add(phase.mul(6.2832))
      .add(stem.mul(5)),
  )
    .mul(FLUTTER_METRES)
    .mul(bend);
  const seconds = leanSeconds(assetId, height);
  const { speed, gustDepth } = current.parameters;
  const ambientPeak = Math.hypot(speed * (1 + gustDepth), speed * gustDepth * MEANDER_AMPLITUDE);
  const shear = vec3(flow.x, 0, flow.z).mul(seconds);
  const lean = limitLeanNode(shear, ambientPeak * seconds, PUMP_LEAN_HEIGHT * height).mul(bend);
  material.positionNode = positionLocal.add(lean).add(vec3(flutter, 0, flutter.mul(0.6)));
  return material;
}

const matrix = new Matrix4();
const quaternion = new Quaternion();
const euler = new Euler();
const position = new Vector3();
const scale = new Vector3();
const colour = new Color();

function writeInstance(mesh: InstancedMesh, index: number, entry: PlantEntry): void {
  euler.set(entry.tiltX, entry.yaw, entry.tiltZ, 'YXZ');
  quaternion.setFromEuler(euler);
  position.set(entry.x, entry.y, entry.z);
  scale.set(entry.scale, entry.scale, entry.scale);
  matrix.compose(position, quaternion, scale);
  mesh.setMatrixAt(index, matrix);
  mesh.setColorAt(index, colour.setScalar(entry.tone));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

/** All instances of one plant species, drawn as one InstancedMesh per material. */
export class PlantGroup {
  readonly object = new Group();
  readonly total: number;
  /** The layout plants the instances were built from; null once `setEntry` has moved one. */
  layoutSignature: string | null;
  private readonly sorted: readonly PlantEntry[];
  private readonly meshes: InstancedMesh[] = [];
  private readonly materials: MeshStandardNodeMaterial[] = [];
  private readonly placed: PlantEntry[];
  /** Per-instance pump gain (x, z pairs) this group's shaders read. */
  readonly pumpGain: Float32Array;
  private readonly pumpAttributes: InstancedBufferAttribute[] = [];
  private readonly releasePump: () => void;
  private readonly gainAt = new Float64Array(2);

  constructor(
    readonly assetId: string,
    model: LoadedModel,
    entries: readonly PlantEntry[],
    private readonly current: CurrentField,
  ) {
    this.object.name = `plants:${assetId}`;
    const ordered = [...entries].sort((a, b) => a.rank - b.rank);
    this.total = ordered.length;
    this.layoutSignature = JSON.stringify(ordered.filter((e) => e.rank < 0));
    this.sorted = ordered;
    this.placed = [...ordered];
    this.pumpGain = new Float32Array(Math.max(1, ordered.length) * 2);
    for (const { geometry, material: source } of model.primitives) {
      const pumpAttribute = new InstancedBufferAttribute(this.pumpGain, 2);
      this.pumpAttributes.push(pumpAttribute);
      const material = createSwayMaterial(source, geometry, assetId, current, pumpAttribute);
      this.materials.push(material);
      const mesh = new InstancedMesh(geometry, material, Math.max(1, ordered.length));
      mesh.name = `${assetId}:${source.name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      ordered.forEach((entry, i) => writeInstance(mesh, i, entry));
      this.meshes.push(mesh);
      this.object.add(mesh);
    }
    this.refreshPump();
    this.releasePump = current.onWaveMakerChange(() => this.refreshPump());
  }

  private refreshPump(): void {
    this.placed.forEach((entry, i) => this.writePump(i, entry));
    for (const attr of this.pumpAttributes) attr.needsUpdate = true;
  }

  private writePump(index: number, entry: PlantEntry): void {
    this.current.pumpGainAt(entry.x, entry.y, entry.z, this.gainAt);
    this.pumpGain[index * 2] = this.gainAt[0] ?? 0;
    this.pumpGain[index * 2 + 1] = this.gainAt[1] ?? 0;
  }

  get visible(): number {
    return this.meshes[0]?.count ?? 0;
  }

  /** Rewrites one instance in place; `index` counts in thinning order, so layout plants come first. */
  setEntry(index: number, entry: PlantEntry): void {
    this.layoutSignature = null;
    this.placed[index] = entry;
    this.writePump(index, entry);
    for (const attr of this.pumpAttributes) attr.needsUpdate = true;
    for (const mesh of this.meshes) writeInstance(mesh, index, entry);
  }

  /** Shows the plants whose thinning rank is below `density`; layout plants (rank -1) always show. */
  setDensity(density: number): void {
    const count = visibleAtDensity(this.sorted, density);
    for (const mesh of this.meshes) mesh.count = count;
  }

  dispose(): void {
    this.releasePump();
    for (const mesh of this.meshes) mesh.dispose();
    for (const material of this.materials) material.dispose();
    this.object.removeFromParent();
  }
}
