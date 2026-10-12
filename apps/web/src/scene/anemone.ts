import {
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  type BufferGeometry,
  type MeshStandardMaterial,
} from 'three/webgpu';
import { attribute, positionLocal, sin, vec3 } from 'three/tsl';
import type { DecorItem } from '@aquarium/shared';
import type { CatalogEntry, LoadedModel } from './assets';
import type { CapsuleCollider } from './colliders';
import { wrapPeriodS, type CurrentField, type CurrentParameters } from './current';
import { decorMatrix } from './hardscape';

export const SWAY_ATTRIBUTE = '_sway';

/** Whole waves per current wrap period, so the undulation loops without a visible seam. */
const WAVES_PER_WRAP = 12;
const WAVE_METRES = 0.012;
/** Seconds of current a tentacle tip leans into. */
const LEAN_SECONDS = 0.35;
const TWO_PI = Math.PI * 2;

/** The scene point a species is drawn to; the shape `packages/sim` takes in `setAnchors`. */
export interface SceneAnchor {
  readonly id: string;
  readonly kind: 'anemone' | 'cave';
  readonly position: readonly [number, number, number];
  readonly radius: number;
}

function spread(entry: CatalogEntry): number {
  const b = entry.bounds;
  if (!b) throw new Error(`Anemone "${entry.id}" has no bounds in the asset index`);
  return Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[2]), Math.abs(b.max[2]));
}

function height(entry: CatalogEntry): number {
  const top = entry.bounds?.max[1];
  if (top === undefined) throw new Error(`Anemone "${entry.id}" has no bounds in the asset index`);
  return top;
}

export function anemoneAnchor(id: string, entry: CatalogEntry, item: DecorItem): SceneAnchor {
  const [x, y, z] = item.position;
  return {
    id,
    kind: 'anemone',
    position: [x, y + height(entry) * item.scale * 0.5, z],
    radius: spread(entry) * item.scale * 0.45,
  };
}

/** Soft, so fish may brush through the tentacles but steering still avoids the column. */
export function anemoneCollider(entry: CatalogEntry, item: DecorItem): CapsuleCollider {
  const [x, y, z] = item.position;
  const radius = spread(entry) * item.scale * 0.45;
  const top = Math.max(radius, height(entry) * item.scale * 0.8);
  return { kind: 'capsule', hard: false, a: [x, y + radius, z], b: [x, y + top, z], radius };
}

/** Furthest a tentacle tip strays horizontally from the item's position, over the whole gust cycle. */
export function anemoneReach(
  entry: CatalogEntry,
  item: DecorItem,
  current: CurrentParameters,
): number {
  const peakFlow = current.speed * (1 + current.gustDepth);
  return (spread(entry) + WAVE_METRES) * item.scale + peakFlow * LEAN_SECONDS;
}

function createAnemoneMaterial(
  source: MeshStandardMaterial,
  geometry: BufferGeometry,
  item: DecorItem,
  current: CurrentField,
): MeshStandardNodeMaterial {
  if (!geometry.getAttribute(SWAY_ATTRIBUTE)) {
    throw new Error(
      `Anemone geometry has no ${SWAY_ATTRIBUTE} attribute; rebuild with pnpm build:assets`,
    );
  }
  const material = new MeshStandardNodeMaterial();
  material.name = `${source.name || 'anemone'}-sway`;
  material.color.copy(source.color);
  material.map = source.map;
  material.normalMap = source.normalMap;
  material.normalScale.copy(source.normalScale);
  material.roughness = Math.max(source.roughness, 0.45);
  material.metalness = 0;
  material.side = DoubleSide;

  const sway = attribute(SWAY_ATTRIBUTE, 'float');
  const tip = sway.mul(sway);
  const omega = (TWO_PI * WAVES_PER_WRAP) / wrapPeriodS(current.parameters);
  const phase = positionLocal.x.mul(23).add(positionLocal.z.mul(17));
  const angle = current.elapsed.mul(omega).add(phase);
  const wave = vec3(sin(angle), sin(angle.mul(2).add(1.7)).mul(0.4), sin(angle.add(1.9))).mul(
    sway.mul(WAVE_METRES),
  );
  const origin = vec3(...item.position);
  const flow = current.velocityNode(positionLocal.mul(item.scale).add(origin));
  const [cos, sinYaw] = [Math.cos(item.rotationY), Math.sin(item.rotationY)];
  const localFlow = vec3(
    flow.x.mul(cos).sub(flow.z.mul(sinYaw)),
    0,
    flow.x.mul(sinYaw).add(flow.z.mul(cos)),
  );
  const lean = localFlow.mul(tip.mul(LEAN_SECONDS / item.scale));
  material.positionNode = positionLocal.add(lean).add(wave);
  return material;
}

/** One host anemone: a single mesh whose tentacles stream in the shared current on the GPU. */
export class AnemoneGroup {
  readonly object = new Group();
  private readonly materials: MeshStandardNodeMaterial[] = [];

  constructor(entry: CatalogEntry, model: LoadedModel, item: DecorItem, current: CurrentField) {
    this.object.name = `anemone:${entry.id}`;
    const matrix: Matrix4 = decorMatrix(item);
    for (const { geometry, material: source } of model.primitives) {
      const material = createAnemoneMaterial(source, geometry, item, current);
      this.materials.push(material);
      const mesh = new Mesh(geometry, material);
      mesh.name = `${entry.id}:${source.name}`;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.object.add(mesh);
    }
  }

  dispose(): void {
    for (const material of this.materials) material.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }
}
