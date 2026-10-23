import {
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  type BufferGeometry,
  type MeshStandardMaterial,
  type Node,
} from 'three/webgpu';
import { attribute, float, positionLocal, sin, vec3 } from 'three/tsl';
import type { DecorItem } from '@aquarium/shared';
import type { CatalogEntry, LoadedModel } from './assets';
import type { CapsuleCollider } from './colliders';
import {
  limitLean,
  limitLeanNode,
  MEANDER_AMPLITUDE,
  PUMP_LEAN_HEIGHT,
  wrapPeriodS,
  type CurrentField,
  type CurrentParameters,
  type PumpRoot,
} from './current';
import { decorMatrix } from './hardscape';
import { contractionGain, polypSizeNode } from './polyps';

export const SWAY_ATTRIBUTE = '_sway';

/** Whole waves per current wrap period, so the undulation loops without a visible seam. */
export const WAVES_PER_WRAP = 12;
const WAVE_METRES = 0.012;
/** Seconds of current a tentacle tip leans into. */
export const LEAN_SECONDS = 0.35;
const TWO_PI = Math.PI * 2;

/**
 * The scene point a species is drawn to, in the frame the scene and sim share. `FishSystem`
 * puts it in the `SimWorldSpec` and re-sends it to each new sim world, after `sceneAnchorsToSim`
 * (`fish/demoStock.ts`) clamps it into the water.
 */
export interface SceneAnchor {
  readonly id: string;
  readonly kind: 'anemone' | 'cave' | 'bank';
  readonly position: readonly [number, number, number];
  readonly radius: number;
  /** Outward direction of a cave mouth. */
  readonly facing?: readonly [number, number, number];
}

function spread(entry: CatalogEntry): number {
  const b = entry.bounds;
  if (!b) throw new Error(`Anemone "${entry.id}" has no bounds in the asset index`);
  return Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[2]), Math.abs(b.max[2]));
}

function horizontalRadius(entry: CatalogEntry): number {
  const b = entry.bounds;
  if (!b) throw new Error(`Anemone "${entry.id}" has no bounds in the asset index`);
  return Math.max(
    ...[b.min[0], b.max[0]].flatMap((x) => [b.min[2], b.max[2]].map((z) => Math.hypot(x, z))),
  );
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
  const peakFlow = Math.hypot(
    current.speed * (1 + current.gustDepth),
    current.speed * current.gustDepth * MEANDER_AMPLITUDE,
  );
  const room = PUMP_LEAN_HEIGHT * height(entry) * item.scale;
  const lean = limitLean(
    (peakFlow + (current.pumpMps ?? 0)) * LEAN_SECONDS,
    peakFlow * LEAN_SECONDS,
    room,
  );
  return (horizontalRadius(entry) + WAVE_METRES) * item.scale + lean;
}

/** Tentacle streaming shared by every swaying polyp: lean into the current plus a travelling wave, both weighted by the `_sway` attribute. */
export function swayPositionNode(
  item: DecorItem,
  current: CurrentField,
  waveMetres: number,
  leanSeconds: number,
  pumpRoom: number,
  pump: PumpRoot,
  base: Node<'vec3'> = positionLocal,
  scale: Node<'float'> = float(item.scale),
) {
  const sway = attribute(SWAY_ATTRIBUTE, 'float');
  const tip = sway.mul(sway);
  const omega = (TWO_PI * WAVES_PER_WRAP) / wrapPeriodS(current.parameters);
  const phase = positionLocal.x.mul(23).add(positionLocal.z.mul(17));
  const angle = current.elapsed.mul(omega).add(phase);
  const wave = vec3(sin(angle), sin(angle.mul(2).add(1.7)).mul(0.4), sin(angle.add(1.9))).mul(
    sway.mul(waveMetres),
  );
  const origin = vec3(...item.position);
  const flow = current
    .velocityNode(positionLocal.mul(scale).add(origin))
    .add(current.pumpVelocity(pump.gain));
  const [cos, sinYaw] = [Math.cos(item.rotationY), Math.sin(item.rotationY)];
  const localFlow = vec3(
    flow.x.mul(cos).sub(flow.z.mul(sinYaw)),
    0,
    flow.x.mul(sinYaw).add(flow.z.mul(cos)),
  );
  const { speed, gustDepth } = current.parameters;
  const ambientPeak = Math.hypot(speed * (1 + gustDepth), speed * gustDepth * MEANDER_AMPLITUDE);
  const linear = scale.reciprocal().mul(ambientPeak * leanSeconds);
  const lean = limitLeanNode(
    localFlow.mul(scale.reciprocal().mul(leanSeconds)),
    linear,
    pumpRoom,
  ).mul(tip);
  return base.add(lean).add(wave);
}

/** Tentacles draw in towards the foot as `size` falls, more the nearer their tips. */
export function contractedTentacles(
  size: Node<'float'>,
  position: Node<'vec3'> = positionLocal,
  sway: Node<'float'> = attribute(SWAY_ATTRIBUTE, 'float'),
): Node<'vec3'> {
  const pull = sway.mul(size.oneMinus()).oneMinus();
  return vec3(position.x.mul(pull), position.y, position.z.mul(pull));
}

function createAnemoneMaterial(
  source: MeshStandardMaterial,
  geometry: BufferGeometry,
  item: DecorItem,
  current: CurrentField,
  pumpRoom: number,
  pump: PumpRoot,
  size: Node<'float'>,
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

  material.positionNode = swayPositionNode(
    item,
    current,
    WAVE_METRES,
    LEAN_SECONDS,
    pumpRoom,
    pump,
    contractedTentacles(size),
  );
  return material;
}

/** One host anemone: a single mesh whose tentacles stream in the shared current on the GPU. */
export class AnemoneGroup {
  readonly object = new Group();
  private readonly materials: MeshStandardNodeMaterial[] = [];
  private readonly pump: PumpRoot;

  constructor(
    entry: CatalogEntry,
    model: LoadedModel,
    item: DecorItem,
    current: CurrentField,
    polyps: Node<'float'>,
  ) {
    this.object.name = `anemone:${entry.id}`;
    this.pump = current.pumpRoot(...item.position);
    const matrix: Matrix4 = decorMatrix(item);
    for (const { geometry, material: source } of model.primitives) {
      let material: MeshStandardNodeMaterial;
      try {
        material = createAnemoneMaterial(
          source,
          geometry,
          item,
          current,
          PUMP_LEAN_HEIGHT * height(entry),
          this.pump,
          polypSizeNode(polyps, contractionGain(entry.id)),
        );
      } catch (error) {
        for (const earlier of this.materials) earlier.dispose();
        this.pump.dispose();
        throw error;
      }
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
    this.pump.dispose();
    for (const material of this.materials) material.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }
}
