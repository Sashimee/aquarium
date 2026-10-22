import { legacyTintSeed, type DecorItem } from './common.js';
import { TANK_SIZES, type TankSize } from './tankSize.js';

export interface PresetFit {
  readonly lengthRatio: number;
  readonly depthRatio: number;
  /** Sizes shrink with the smaller of the two ratios, never growing past 1. */
  readonly scale: number;
}

/**
 * How the presets, authored for the standard tank, stretch to another tank: positions with the
 * glass, sizes with the smaller of length and depth. The web scene fits x, z and scale the same way; it also nudges
 * items off the glass using each model's bounds, which the server does not have.
 */
export function presetFit(size: TankSize): PresetFit {
  const standard = TANK_SIZES.standard.dimensions;
  const { length, depth } = TANK_SIZES[size].dimensions;
  const lengthRatio = length / standard.length;
  const depthRatio = depth / standard.depth;
  return { lengthRatio, depthRatio, scale: Math.min(1, lengthRatio, depthRatio) };
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
    scale: item.scale * scale,
  };
}
