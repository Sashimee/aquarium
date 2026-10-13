import { Color } from 'three/webgpu';

/**
 * Scan-derived corals arrive in dull museum tones, so the scene tints each instance toward live
 * tissue colour. Palettes are multiplied into the base colour map, each channel stays at or below 1 so albedo never exceeds the scan's.
 */
const TINTS: Readonly<Record<string, readonly (readonly [number, number, number])[]>> = {
  'acropora-cytherea': [
    [0.4, 0.22, 1],
    [1, 0.4, 0.17],
  ],
  'acropora-palmata': [
    [0.38, 1, 0.25],
    [1, 0.3, 0.53],
  ],
  'brain-coral': [
    [0.33, 1, 0.33],
    [1, 0.47, 0.18],
    [0.25, 0.75, 1],
  ],
};

/** Fraction of the scan's height kept, so the tall brain-coral core reads as a low dome. */
const HEIGHT_SCALE: Readonly<Record<string, number>> = { 'brain-coral': 0.55 };

/** Stable across layout edits: the same placement always gets the same colour. */
export function placementKey(position: readonly number[], rotationY: number): number {
  let h = 2166136261;
  for (const v of [...position, rotationY]) {
    h = Math.imul(h ^ Math.round(v * 1000), 16777619) >>> 0;
  }
  return h;
}

export function coralTint(assetId: string, key: number): Color | null {
  const palette = TINTS[assetId];
  const rgb = palette?.[key % palette.length];
  return rgb ? new Color(rgb[0], rgb[1], rgb[2]) : null;
}

export function heightScale(assetId: string): number {
  return HEIGHT_SCALE[assetId] ?? 1;
}
