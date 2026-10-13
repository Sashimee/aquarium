import {
  Color,
  DoubleSide,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type MeshStandardMaterial,
} from 'three/webgpu';
import { float, fract, instanceIndex, positionGeometry, positionLocal, sin, vec3 } from 'three/tsl';
import {
  FLUTTER_HZ,
  MEANDER_AMPLITUDE,
  type CurrentField,
  type CurrentParameters,
} from './current';
import type { LoadedModel } from './assets';
import { MAX_TILT_RAD, type PlantInstance } from './placement';

/** Seconds of current a leaf tip leans into; the bend grows with the square of the height. */
export const SWAY_SECONDS = 1.2;
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
 * `waterTop`. The shader leans plants sideways only, but a tilted root turns part of that lean
 * upwards, so the tallest point is the height plus the lean projected through the maximum tilt.
 */
export function surfaceScaleCeiling(
  waterTop: number,
  assetId: string,
  height: number,
  current: CurrentParameters,
): (rootY: number) => number {
  const reachUp =
    Math.max(height, 1e-3) + maxSway(assetId, height, current) * Math.sin(MAX_TILT_RAD);
  return (rootY) => Math.max(0, (waterTop - SURFACE_MARGIN - rootY) / reachUp);
}

export interface PlantEntry extends PlantInstance {
  /** Position in the patch's thinning order, 0 first to 1 last; layout plants use -1. */
  readonly rank: number;
}

/** Furthest a plant of unit scale and the given height leans, bounded over the whole gust cycle. */
export function maxSway(assetId: string, height: number, current: CurrentParameters): number {
  const forward = current.speed * (1 + current.gustDepth);
  const sideways = current.speed * current.gustDepth * MEANDER_AMPLITUDE;
  const lean = Math.hypot(forward, sideways) * SWAY_SECONDS * swayGain(assetId) * (height / 0.3);
  return lean + FLUTTER_METRES * 1.6;
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
  gain: number,
  current: CurrentField,
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
  const flow = current.velocityNode(positionLocal);
  const phase = fract(sin(float(instanceIndex).mul(12.9898)).mul(43758.5453));
  const flutter = sin(
    current.flutterElapsed
      .mul(FLUTTER_HZ * Math.PI * 2)
      .add(phase.mul(6.2832))
      .add(stem.mul(5)),
  )
    .mul(FLUTTER_METRES)
    .mul(bend);
  const lean = vec3(flow.x, 0, flow.z)
    .mul(SWAY_SECONDS * gain)
    .mul(bend)
    .mul(height / 0.3);
  material.positionNode = positionLocal.add(lean).add(vec3(flutter, 0, flutter.mul(0.6)));
  return material;
}

const matrix = new Matrix4();
const quaternion = new Quaternion();
const euler = new Euler();
const position = new Vector3();
const scale = new Vector3();
const colour = new Color();

/** All instances of one plant species, drawn as one InstancedMesh per material. */
export class PlantGroup {
  readonly object = new Group();
  readonly total: number;
  private readonly sorted: readonly PlantEntry[];
  private readonly meshes: InstancedMesh[] = [];
  private readonly materials: MeshStandardNodeMaterial[] = [];

  constructor(
    readonly assetId: string,
    model: LoadedModel,
    entries: readonly PlantEntry[],
    current: CurrentField,
  ) {
    this.object.name = `plants:${assetId}`;
    const ordered = [...entries].sort((a, b) => a.rank - b.rank);
    this.total = ordered.length;
    this.sorted = ordered;
    for (const { geometry, material: source } of model.primitives) {
      const material = createSwayMaterial(source, geometry, swayGain(assetId), current);
      this.materials.push(material);
      const mesh = new InstancedMesh(geometry, material, Math.max(1, ordered.length));
      mesh.name = `${assetId}:${source.name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      ordered.forEach((entry, i) => {
        euler.set(entry.tiltX, entry.yaw, entry.tiltZ, 'YXZ');
        quaternion.setFromEuler(euler);
        position.set(entry.x, entry.y, entry.z);
        scale.set(entry.scale, entry.scale, entry.scale);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, colour.setScalar(entry.tone));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.meshes.push(mesh);
      this.object.add(mesh);
    }
  }

  get visible(): number {
    return this.meshes[0]?.count ?? 0;
  }

  /** Shows the plants whose thinning rank is below `density`; layout plants (rank -1) always show. */
  setDensity(density: number): void {
    const count = visibleAtDensity(this.sorted, density);
    for (const mesh of this.meshes) mesh.count = count;
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    for (const material of this.materials) material.dispose();
    this.object.removeFromParent();
  }
}
