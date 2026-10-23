import { legacyTintSeed, type DecorItem } from './common.js';
import { TANK_SIZES, type TankSize } from './tankSize.js';

/** Decor never shrinks below this share of its authored size, so a nano tank's rocks stay life-size next to its fish. */
export const DECOR_MIN_SCALE = 0.6;

export interface PresetFit {
  readonly lengthRatio: number;
  readonly depthRatio: number;
  /** Sizes shrink with the smaller of the two ratios, never growing past 1. */
  readonly scale: number;
  /** What rigid decor scales by: `scale`, held at `DECOR_MIN_SCALE`. */
  readonly decorScale: number;
  /** Share of the authored decor the floor has room for, 1 when it all fits. */
  readonly decorShare: number;
}

/**
 * How the presets, authored for the standard tank, stretch to another tank: positions with the
 * glass, sizes with the smaller of length and depth. `fitPresetDecor` is the decor variant: sizes
 * held at `DECOR_MIN_SCALE`, with the items that no longer fit on the floor dropped. The web scene fits x and z the same way and
 * also nudges items off the glass using each model's bounds, which the server does not have. A
 * perch is the exception: the server keeps its authored scale as a rough value only, since the web
 * grows it toward the rim or drops it to ordinary wood by model bounds, and the server never reads
 * a perch's scale for geometry.
 */
export function presetFit(size: TankSize): PresetFit {
  const standard = TANK_SIZES.standard.dimensions;
  const { length, depth } = TANK_SIZES[size].dimensions;
  const lengthRatio = length / standard.length;
  const depthRatio = depth / standard.depth;
  const scale = Math.min(1, lengthRatio, depthRatio);
  const decorScale = Math.max(scale, DECOR_MIN_SCALE);
  const decorShare = Math.min(1, (lengthRatio * depthRatio) / (decorScale * decorScale));
  return { lengthRatio, depthRatio, scale, decorScale, decorShare };
}

/**
 * How many of `total` authored items a tank keeps: its floor area over the footprint the items now
 * take at `decorScale`, rounded up, and never fewer than one.
 */
export function presetDecorCount(total: number, size: TankSize): number {
  if (total === 0) return 0;
  return Math.min(total, Math.max(1, Math.ceil(total * presetFit(size).decorShare - 1e-9)));
}

/**
 * The authored items a tank keeps. A preset lists its decor in order of importance, so the tail is
 * what drops; the web scene and the server must both go through this to agree on what is shown.
 */
export function keptPresetDecor<T>(items: readonly T[], size: TankSize): T[] {
  return items.slice(0, presetDecorCount(items.length, size));
}

export function fitPresetDecor(items: readonly DecorItem[], size: TankSize): DecorItem[] {
  const { decorScale } = presetFit(size);
  return keptPresetDecor(items, size).map((item) => {
    const fitted = fitPresetItem(item, size);
    return { ...fitted, scale: item.perch ? item.scale : item.scale * decorScale };
  });
}

/**
 * The colour seed names a plant or coral in the stored growth state, so it comes from the authored
 * item; hashing the fitted position would rename every preset plant. Height is left as authored:
 * the web seats items on the substrate, which the server never reads.
 */
export function fitPresetItem(item: DecorItem, size: TankSize): DecorItem {
  const { lengthRatio, depthRatio, scale } = presetFit(size);
  return {
    ...item,
    tintSeed: item.tintSeed ?? legacyTintSeed(item),
    position: [item.position[0] * lengthRatio, item.position[1], item.position[2] * depthRatio],
    scale: item.perch ? item.scale : item.scale * scale,
  };
}
