import type { DecorItem, Plant } from '@aquarium/shared';
import { Vector3, type Ray } from 'three';
import { MAX_TILT_RAD, ROOT_DEPTH, mulberry32 } from './placement';
import { surfaceScaleCeiling, type PlantEntry } from './plants';

const TONE_MIN = 0.86;
const TONE_MAX = 1.08;
const MAX_ANCESTORS = 64;
const MIN_PICK_RADIUS = 0.03;

/** Mirrors `layoutPlantKeys` in the sim: `s<seed>`, then `s<seed>-2`, `-3` for repeats. */
export function layoutPlantKeys(seeds: readonly number[]): string[] {
  const seen = new Map<string, number>();
  return seeds.map((seed) => {
    const base = `s${seed}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

export function hashKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Yaw, tilt and tone of an offset, a pure function of its key so reloads and catch-up agree. */
export function offsetEntry(
  key: string,
  x: number,
  y: number,
  z: number,
  scale: number,
): PlantEntry {
  const random = mulberry32(hashKey(key));
  return {
    x,
    y,
    z,
    yaw: random() * Math.PI * 2,
    tiltX: (random() - 0.5) * MAX_TILT_RAD,
    tiltZ: (random() - 0.5) * MAX_TILT_RAD,
    scale,
    tone: TONE_MIN + random() * (TONE_MAX - TONE_MIN),
    rank: -1,
  };
}

/** The layout plant an offset descends from, or null when the chain is broken or cyclic. */
export function rootKeyOf(key: string, plants: ReadonlyMap<string, Plant>): string | null {
  let current = plants.get(key);
  for (let steps = 0; current && steps < MAX_ANCESTORS; steps++) {
    if (current.parentKey === null) return current.key;
    current = plants.get(current.parentKey);
  }
  return null;
}

export interface PickablePlant {
  readonly key: string;
  readonly size: number;
  readonly minSize: number;
  readonly maxSize: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Drawn height and half-width, size already applied. */
  readonly height: number;
  readonly radius: number;
}

export interface PlantPick {
  readonly key: string;
  readonly size: number;
  readonly minSize: number;
  readonly maxSize: number;
  /** Distance along the ray to the closest approach to the plant's stem. */
  readonly distance: number;
}

const top = new Vector3();
const base = new Vector3();
const onRay = new Vector3();
const onStem = new Vector3();

/** The plant whose stem the ray passes within reach of, nearest the ray origin first. */
export function pickPlant(ray: Ray, plants: readonly PickablePlant[]): PlantPick | null {
  let best: PlantPick | null = null;
  for (const plant of plants) {
    base.set(plant.x, plant.y, plant.z);
    top.set(plant.x, plant.y + plant.height, plant.z);
    const reach = Math.max(plant.radius, MIN_PICK_RADIUS);
    const gap2 = ray.distanceSqToSegment(base, top, onRay, onStem);
    if (gap2 > reach * reach) continue;
    const distance = onRay.distanceTo(ray.origin);
    if (best && best.distance <= distance) continue;
    best = {
      key: plant.key,
      size: plant.size,
      minSize: plant.minSize,
      maxSize: plant.maxSize,
      distance,
    };
  }
  return best;
}

/** A plant of the decor layout with what the growth maths needs from its model. */
export interface LayoutPlantRef {
  readonly key: string;
  readonly item: DecorItem;
  /** Unscaled model height and half-width, metres. */
  readonly height: number;
  readonly halfWidth: number;
}

export interface GrowthContext {
  readonly plants: ReadonlyMap<string, Plant>;
  readonly ground: (x: number, z: number) => number;
  readonly waterTop: number;
}

function grownScale(base: number, size: number, height: number, y: number, waterTop: number) {
  const ceiling = surfaceScaleCeiling(waterTop, height)(y);
  return Math.min(base * size, Math.max(base, ceiling));
}

/** The layout item at its grown size; a plant the state does not know about stays as laid out. */
export function grownItem(ref: LayoutPlantRef, context: GrowthContext): DecorItem {
  const plant = context.plants.get(ref.key);
  if (!plant || plant.parentKey !== null || plant.assetId !== ref.item.assetId) return ref.item;
  const scale = grownScale(
    ref.item.scale,
    plant.size,
    ref.height,
    ref.item.position[1],
    context.waterTop,
  );
  return scale === ref.item.scale ? ref.item : { ...ref.item, scale };
}

interface Placed {
  readonly plant: Plant;
  readonly ref: LayoutPlantRef;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
}

function placedOffsets(refs: readonly LayoutPlantRef[], context: GrowthContext): Placed[] {
  const byKey = new Map(refs.map((ref) => [ref.key, ref]));
  const placed: Placed[] = [];
  for (const plant of context.plants.values()) {
    if (plant.parentKey === null || plant.position === null) continue;
    const rootKey = rootKeyOf(plant.key, context.plants);
    const ref = rootKey === null ? undefined : byKey.get(rootKey);
    if (!ref || ref.item.assetId !== plant.assetId) continue;
    const [x, z] = plant.position;
    const y = context.ground(x, z) - ROOT_DEPTH;
    const scale = grownScale(ref.item.scale, plant.size, ref.height, y, context.waterTop);
    placed.push({ plant, ref, x, y, z, scale });
  }
  return placed;
}

/**
 * The offsets (runners and carpet daughters) as instances of their parent's asset, rooted on the
 * substrate. An offset whose root is no longer in the layout is dropped until the layout catches up.
 */
export function offsetEntries(
  refs: readonly LayoutPlantRef[],
  context: GrowthContext,
): Map<string, PlantEntry[]> {
  const byAsset = new Map<string, PlantEntry[]>();
  for (const { plant, x, y, z, scale } of placedOffsets(refs, context)) {
    const list = byAsset.get(plant.assetId) ?? [];
    list.push(offsetEntry(plant.key, x, y, z, scale));
    byAsset.set(plant.assetId, list);
  }
  return byAsset;
}

/** Every grown plant and offset a ray can pick, with its key and size. */
export function pickablePlants(
  refs: readonly LayoutPlantRef[],
  context: GrowthContext,
): PickablePlant[] {
  const out: PickablePlant[] = [];
  for (const ref of refs) {
    const plant = context.plants.get(ref.key);
    if (!plant || plant.parentKey !== null || plant.assetId !== ref.item.assetId) continue;
    const scale = grownItem(ref, context).scale;
    out.push({
      key: plant.key,
      size: plant.size,
      minSize: plant.minSize,
      maxSize: plant.maxSize,
      x: ref.item.position[0],
      y: ref.item.position[1],
      z: ref.item.position[2],
      height: ref.height * scale,
      radius: ref.halfWidth * scale * 0.5,
    });
  }
  for (const { plant, ref, x, y, z, scale } of placedOffsets(refs, context)) {
    out.push({
      key: plant.key,
      size: plant.size,
      minSize: plant.minSize,
      maxSize: plant.maxSize,
      x,
      y,
      z,
      height: ref.height * scale,
      radius: ref.halfWidth * scale * 0.5,
    });
  }
  return out;
}
