import { Color } from 'three/webgpu';
import type { Biome } from '@aquarium/shared';

/**
 * Scan-derived corals arrive in dull museum tones, so the scene tints each instance toward live
 * tissue colour. Palettes are multiplied into the base colour map, each channel stays at or below 1 so albedo never exceeds the scan's.
 */
type Rgb = readonly [number, number, number];

/** Acropora scans carry saturated live colour already, so a full-strength multiply only darkens it. */
const ACROPORA_TINT_STRENGTH = 0.35;

const lighten = (palette: readonly Rgb[]): Rgb[] =>
  palette.map(([r, g, b]) => [
    1 - (1 - r) * ACROPORA_TINT_STRENGTH,
    1 - (1 - g) * ACROPORA_TINT_STRENGTH,
    1 - (1 - b) * ACROPORA_TINT_STRENGTH,
  ]);

const TINTS: Readonly<Record<string, readonly Rgb[]>> = {
  'acropora-cytherea': lighten([
    [0.4, 0.22, 1],
    [1, 0.4, 0.17],
  ]),
  'acropora-palmata': lighten([
    [0.38, 1, 0.25],
    [1, 0.3, 0.53],
  ]),
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

/**
 * Emission of the fluorescent proteins in live tissue, parallel to `TINTS`: the same placement key
 * picks a tint and its glow. Green, orange and pink, the colours reef corals fluoresce in.
 */
const GLOW: Readonly<Record<string, readonly Rgb[]>> = {
  'acropora-cytherea': [
    [1, 0.18, 0.62],
    [1, 0.42, 0.06],
  ],
  'acropora-palmata': [
    [0.1, 1, 0.22],
    [1, 0.18, 0.62],
  ],
  'brain-coral': [
    [0.1, 1, 0.22],
    [1, 0.42, 0.06],
    [1, 0.18, 0.62],
  ],
};

/** Share of the absorbed blue that comes back out as visible light. */
const FLUORESCENCE_YIELD = 0.1;

/** Fluorescence exists only on a reef; freshwater has no coral and gets no glow. */
export function coralGlow(biome: Biome, assetId: string, key: number): Color | null {
  if (biome !== 'reef') return null;
  const palette = GLOW[assetId];
  const rgb = palette?.[key % palette.length];
  return rgb ? new Color(rgb[0], rgb[1], rgb[2]) : null;
}

/**
 * Emission scale for a blue excitation radiance. The square root keeps the moonlight, which is
 * about a tenth of the day's actinic, visible at night while the day does not blow out.
 */
export function fluorescenceLevel(excitation: number): number {
  return FLUORESCENCE_YIELD * Math.sqrt(Math.max(excitation, 0));
}
