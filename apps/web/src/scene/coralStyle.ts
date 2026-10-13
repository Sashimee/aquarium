import { Color } from 'three/webgpu';

/**
 * Scan-derived corals arrive in dull museum tones, so the scene tints each instance toward live
 * tissue colour. Palettes are multiplied into the base colour map, hence the saturated values.
 */
const TINTS: Readonly<Record<string, readonly (readonly [number, number, number])[]>> = {
  'acropora-cytherea': [
    [0.7, 0.4, 1.8],
    [1.8, 0.7, 0.3],
  ],
  'acropora-palmata': [
    [0.6, 1.6, 0.4],
    [1.7, 0.5, 0.9],
  ],
  'brain-coral': [
    [0.5, 1.5, 0.5],
    [1.7, 0.8, 0.3],
    [0.4, 1.2, 1.6],
  ],
};

/** Fraction of the scan's height kept, so the tall brain-coral core reads as a low dome. */
const HEIGHT_SCALE: Readonly<Record<string, number>> = { 'brain-coral': 0.55 };

export function coralTint(assetId: string, ordinal: number): Color | null {
  const palette = TINTS[assetId];
  const rgb = palette?.[ordinal % palette.length];
  return rgb ? new Color(rgb[0], rgb[1], rgb[2]) : null;
}

export function heightScale(assetId: string): number {
  return HEIGHT_SCALE[assetId] ?? 1;
}
