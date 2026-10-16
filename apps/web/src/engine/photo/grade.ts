export const PHOTO_FILTERS = ['natural', 'vivid', 'cool', 'warm', 'bw'] as const;

export type PhotoFilter = (typeof PHOTO_FILTERS)[number];

export function isPhotoFilter(value: unknown): value is PhotoFilter {
  return typeof value === 'string' && (PHOTO_FILTERS as readonly string[]).includes(value);
}

/** Contrast pivots on mid grey, so it leaves exposure alone. */
export const GREY = 0.18;

/** Rec. 709 luminance of linear RGB. */
export const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** Row-major 3x3, applied to linear scene-referred RGB as a column vector. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface Grade {
  readonly matrix: Mat3;
  /** Power around `GREY` in linear light: 1 keeps the image, above 1 adds contrast. */
  readonly contrast: number;
}

interface GradeRecipe {
  readonly saturation: number;
  /** Linear white-balance gains, rescaled so they keep luminance. */
  readonly balance: readonly [number, number, number];
  readonly contrast: number;
}

/**
 * Gains of roughly a 1500 K white-balance shift either way from the hood's 6500 K. Underwater
 * pictures are already blue-green, so warm is the corrective one and cool the moody one.
 */
const RECIPES: Readonly<Record<PhotoFilter, GradeRecipe>> = {
  natural: { saturation: 1, balance: [1, 1, 1], contrast: 1 },
  vivid: { saturation: 1.35, balance: [1, 1, 1], contrast: 1.12 },
  cool: { saturation: 0.95, balance: [0.86, 0.98, 1.18], contrast: 1.04 },
  warm: { saturation: 1.05, balance: [1.2, 1.02, 0.8], contrast: 1.04 },
  bw: { saturation: 0, balance: [1, 1, 1], contrast: 1.18 },
};

/**
 * The grade for `filter`: white balance, then saturation about each pixel's own luminance. Both
 * are linear-light operations, so the grade runs before tone mapping. Every filter keeps the
 * luminance of grey, and those with a neutral balance keep grey grey and every pixel's luminance.
 */
export function photoGrade(filter: PhotoFilter): Grade {
  const { saturation: s, balance, contrast } = RECIPES[filter];
  const [lr, lg, lb] = LUMA;
  const balanceLuma = lr * balance[0] + lg * balance[1] + lb * balance[2];
  const [gr, gg, gb] = balance.map((g) => g / balanceLuma) as [number, number, number];
  const k = 1 - s;
  return {
    // prettier-ignore
    matrix: [
      (k * lr + s) * gr, k * lg * gg, k * lb * gb,
      k * lr * gr, (k * lg + s) * gg, k * lb * gb,
      k * lr * gr, k * lg * gg, (k * lb + s) * gb,
    ],
    contrast,
  };
}
