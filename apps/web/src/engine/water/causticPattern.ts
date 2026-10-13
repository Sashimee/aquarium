/**
 * The caustic pattern's shape, shared by the TSL shader in `caustics.ts` and a CPU replica of it
 * here, which the tests sample for statistics. Distances are in caustic cells.
 */
export const PATTERN = {
  featureWander: 0.38,
  /** Two crossed waves, in radians per cell along x and y, that bend the cell borders into curves. */
  warpWaves: [
    [0.31, 1.07],
    [0.93, -0.27],
  ],
  warpRates: [0.5, -0.4],
  warpAmplitude: 0.3,
  /** Filament half-width where the surface focuses the light onto the floor, and where it does not. */
  focusedWidth: 0.1,
  defocusedWidth: 0.45,
  edgePower: 3,
  /** Lattice frequencies, per cell, of the two octaves of the focus field: patches of 3 to 6 cells. */
  focusOctaves: [
    { scale: 0.17, weight: 0.65 },
    { scale: 0.39, weight: 0.35 },
  ],
  /** The summed octaves are pushed apart between these, so patches read as focused or not. */
  focusEdges: [0.2, 0.8],
  /** The focus field drifts this much slower than the cells wander. */
  focusRate: 0.12,
  /** Share of the net's contrast left where the light is defocused: a soft, even patch. */
  defocusedContrast: 0.35,
  /** Lattice frequency of the noise that fades filaments in and out along their length. */
  breakupScale: 0.55,
  breakupDrift: [0.11, -0.07],
  breakupEdges: [0.4, 0.75],
  /** Faintest a filament gets where it breaks up, relative to its full brightness. */
  breakupFloor: 0.05,
  /** The second, finer net of the high tiers stands for the surface's shorter ripples. */
  fineScale: 1.7,
  fineOffset: [13.1, 7.3],
  fineRate: 1.3,
  layerWeights: [0.7, 0.3],
} as const;

/**
 * 1 / mean of the caustic net, measured by Monte Carlo over position, time and focus. Scaling by
 * it keeps the average light reaching the substrate unchanged: caustics only redistribute energy.
 */
export const PATTERN_GAIN = 41.6;

/**
 * Untiled cell ids wrap at this before they are hashed. The net drifts, so its ids grow for as
 * long as the tab is open, and a `fract(sin)` hash of a large argument degrades into visible
 * structure on mobile GPUs. 289 cells is over 20 m at the default density, so the repeat is never
 * in view.
 */
export const HASH_WRAP = 289;

/** The low tier's baked tile of one net. */
export const BAKE = {
  periodCells: 10,
  size: 512,
  /**
   * The low tier sees the tile minified, at a grazing angle across the floor, where the thinnest
   * filaments would average away in its mips: it bakes them no sharper than half-focused.
   */
  focus: 0.5,
} as const;

/** 1 / mean of the baked tile, measured over its texels; it is not the live pattern's mean. */
export const BAKED_GAIN = 37.22;

/** The low tier's baked focus field: a larger tile, since its patches span several cells. */
export const FOCUS_BAKE = { periodCells: 64, size: 128 } as const;

const fract = (x: number): number => x - Math.floor(x);
const wrap = (i: number, period: number | null): number => {
  const p = period ?? HASH_WRAP;
  return ((i % p) + p) % p;
};
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

const hash12 = (x: number, y: number): number =>
  fract(Math.sin(x * 419.2 + y * 371.9) * 43758.5453);

const hash22x = (x: number, y: number): number =>
  fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
const hash22y = (x: number, y: number): number =>
  fract(Math.sin(x * 269.5 + y * 183.3) * 43758.5453);

/** On a tile of `period` cells a wave's frequency is rounded to a whole number of cycles, so it wraps. */
export function tiledFrequency(k: number, period: number | null): number {
  if (period === null) return k;
  const turn = (2 * Math.PI) / period;
  return Math.round(k / turn) * turn;
}

/** Smooth value noise in 0..1 with a unit lattice; with `period` set the lattice wraps. */
function valueNoise(x: number, y: number, period: number | null = null): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = wrap(ix, period);
  const x1 = wrap(ix + 1, period);
  const y0 = wrap(iy, period);
  const y1 = wrap(iy + 1, period);
  return mix(mix(hash12(x0, y0), hash12(x1, y0), ux), mix(hash12(x0, y1), hash12(x1, y1), ux), uy);
}

/** Voronoi F2-F1 distance: zero on the cell borders, where the refracted rays converge. */
export function cellEdge(x: number, y: number, t: number, period: number | null = null): number {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const fx = x - cx;
  const fy = y - cy;
  let f1 = 8;
  let f2 = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const idx = wrap(cx + i, period);
      const idy = wrap(cy + j, period);
      const hx = hash22x(idx, idy);
      const hy = hash22y(idx, idy);
      const wx = Math.sin(t + hx * 2 * Math.PI);
      const wy = Math.sin(t * 1.13 + hy * 2 * Math.PI);
      const dx = i + 0.5 + wx * PATTERN.featureWander - fx;
      const dy = j + 0.5 + wy * PATTERN.featureWander - fy;
      const d = Math.hypot(dx, dy);
      f2 = Math.min(f2, Math.max(f1, d));
      f1 = Math.min(f1, d);
    }
  }
  return f2 - f1;
}

function warp(x: number, y: number, t: number, period: number | null): [number, number] {
  const [a, b] = PATTERN.warpWaves;
  const phase = (wave: readonly [number, number], rate: number): number =>
    tiledFrequency(wave[0], period) * x + tiledFrequency(wave[1], period) * y + rate * t;
  return [
    x + PATTERN.warpAmplitude * Math.sin(phase(a, PATTERN.warpRates[0])),
    y + PATTERN.warpAmplitude * Math.sin(phase(b, PATTERN.warpRates[1])),
  ];
}

/** A noise lattice of `scale` per cell; on a tile of `period` cells it is rounded so it wraps. */
export function lattice(
  scale: number,
  period: number | null,
): { scale: number; period: number | null } {
  if (period === null) return { scale, period: null };
  const cells = Math.max(1, Math.round(period * scale));
  return { scale: cells / period, period: cells };
}

/** 0 where the surface spreads the light into a soft blur .. 1 where it focuses it into sharp filaments. */
export function focusAt(x: number, y: number, t: number, period: number | null = null): number {
  const drift = t * PATTERN.focusRate;
  let n = 0;
  PATTERN.focusOctaves.forEach((octave, k) => {
    const grid = lattice(octave.scale, period);
    n +=
      octave.weight *
      valueNoise(x * grid.scale + drift * (k + 1), y * grid.scale - drift * 0.6, grid.period);
  });
  return smoothstep(PATTERN.focusEdges[0], PATTERN.focusEdges[1], n);
}

/** How much of a filament's brightness survives at a point: filaments fade and break up along their length. */
function breakupAt(x: number, y: number, t: number, period: number | null = null): number {
  const grid = lattice(PATTERN.breakupScale, period);
  const n = valueNoise(
    x * grid.scale + t * PATTERN.breakupDrift[0],
    y * grid.scale + t * PATTERN.breakupDrift[1],
    grid.period,
  );
  return mix(
    PATTERN.breakupFloor,
    1,
    smoothstep(PATTERN.breakupEdges[0], PATTERN.breakupEdges[1], n),
  );
}

/**
 * A filament's profile across its width. Focused filaments are narrow and bright, defocused ones
 * wide and dim, with about the same light in each, as a lens moved off its focal plane does.
 */
function filament(edge: number, focus: number): number {
  const width = mix(PATTERN.defocusedWidth, PATTERN.focusedWidth, focus);
  const profile = Math.max(0, 1 - edge / width) ** PATTERN.edgePower;
  return (profile * PATTERN.focusedWidth) / width;
}

/** One caustic net at cell coordinates (x, y), in 0..1. */
export function netAt(
  x: number,
  y: number,
  t: number,
  focus: number,
  period: number | null = null,
): number {
  const [wx, wy] = warp(x, y, t, period);
  return filament(cellEdge(wx, wy, t, period), focus) * breakupAt(x, y, t, period);
}

/** The two nets of the high tiers. */
export function layeredAt(x: number, y: number, t: number, focus: number): number {
  const near = netAt(x, y, t, focus);
  const far = netAt(
    x * PATTERN.fineScale + PATTERN.fineOffset[0],
    y * PATTERN.fineScale + PATTERN.fineOffset[1],
    t * PATTERN.fineRate,
    focus,
  );
  return near * PATTERN.layerWeights[0] + far * PATTERN.layerWeights[1];
}

/** The baked tile's value at cell coordinates (x, y) of the tile. */
export function bakedTileAt(x: number, y: number): number {
  const period = BAKE.periodCells;
  return netAt(x, y, 0, focusAt(x, y, 0, period) * BAKE.focus, period);
}
