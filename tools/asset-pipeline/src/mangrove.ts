import type { EnvironmentRecipe, SubstrateRecipe } from './environment.ts';
import type { FishRecipe } from './fish.ts';
import type { LoftFishRecipe } from './loft-fish.ts';
import { sectionEdges, type SectionKey } from './loft.ts';
import { clamp, smoothstep } from './math.ts';

export const MANGROVE_FISH_RECIPES: FishRecipe[] = [
  {
    id: 'barred-mudskipper',
    species: 'barred-mudskipper',
    sourceId: 'sketchfab-c3bc5a29',
    axes: { forward: '+x', up: '+y' },
    keepMaterial: /^ISG111/,
    lodPlan: { ratios: [0.065, 0.025, 0.01], minTriangles: 150, sloppyFallback: true },
    fallbackLengthM: 0.09,
    hints: { peduncleFromSnout: 0.8241 },
    modifications: [
      "scan slate ('Material.001', 12 triangles) dropped; 217k triangles decimated to about 14k at LOD0, 4096 px colour map downscaled to the 1k and 2k tiers",
    ],
  },
  {
    id: 'blue-spotted-mudskipper',
    species: 'blue-spotted-mudskipper',
    sourceId: 'sketchfab-0fe8a8af',
    axes: { forward: '+x', up: '+y' },
    keepMaterial: /^Q11533/,
    lodPlan: { ratios: [0.036, 0.014, 0.0055], minTriangles: 150, sloppyFallback: true },
    fallbackLengthM: 0.11,
    hints: { peduncleFromSnout: 0.8494 },
    modifications: [
      "scan slate ('Material.001', 12 triangles) dropped; 392k triangles decimated to about 14k at LOD0, 4096 px colour map downscaled to the 1k and 2k tiers",
    ],
  },
];

export type Rgb = [number, number, number];

export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const PIXELS_PER_SL = 760;
const MARGIN_PX = 40;

export interface Canvas {
  width: number;
  height: number;
  snoutPixel: [number, number];
  tailPixel: [number, number];
}

/** Sizes a painting canvas so the loft, its fins and a margin fit; `topY` and `bottomY` bound the fins in standard lengths. */
export function canvasFor(
  sections: SectionKey[],
  topY: number,
  bottomY: number,
  caudalReach = 0.3,
): Canvas {
  const first = sections[0];
  const last = sections.at(-1);
  if (!first || !last) throw new Error('canvasFor needs at least one section');
  const snoutY = (first.top + first.bottom) / 2;
  const tailY = (last.top + last.bottom) / 2;
  const snoutRow = MARGIN_PX + (topY - snoutY) * PIXELS_PER_SL;
  return {
    width: Math.round(2 * MARGIN_PX + (1 + caudalReach) * PIXELS_PER_SL),
    height: Math.round(2 * MARGIN_PX + (topY - bottomY) * PIXELS_PER_SL),
    snoutPixel: [MARGIN_PX, snoutRow],
    tailPixel: [MARGIN_PX + PIXELS_PER_SL, snoutRow - (tailY - snoutY) * PIXELS_PER_SL],
  };
}

interface BodyPoint {
  tn: number;
  yn: number;
  /** 0 at the belly line, 1 at the back, outside 0..1 beyond the body. */
  h: number;
  /** True for fin membranes: behind the peduncle, or above or below the body. */
  fin: boolean;
}

export function locate(sections: SectionKey[], tn: number, yn: number): BodyPoint {
  const { top, bottom } = sectionEdges(sections, clamp(tn, 0, 1));
  const h = (yn - bottom) / (top - bottom);
  return { tn, yn, h, fin: tn > 1 || h < 0 || h > 1 };
}

export function ring(
  tn: number,
  yn: number,
  cx: number,
  cy: number,
  radius: number,
  width: number,
): number {
  return 1 - smoothstep(width * 0.4, width, Math.abs(Math.hypot(tn - cx, yn - cy) - radius));
}

export function disc(tn: number, yn: number, cx: number, cy: number, radius: number): number {
  return 1 - smoothstep(radius * 0.7, radius, Math.hypot(tn - cx, yn - cy));
}

export function band(tn: number, centre: number, half: number, soft: number): number {
  return 1 - smoothstep(half - soft, half + soft, Math.abs(tn - centre));
}

function fract(x: number): number {
  return x - Math.floor(x);
}

/** Cheap deterministic hash noise in 0..1, for scale and freckle texture. */
export function noise(x: number, y: number): number {
  return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
}

export function eyeSpot(
  tn: number,
  yn: number,
  cx: number,
  cy: number,
  radius: number,
  iris: Rgb,
): Rgb | null {
  const d = Math.hypot(tn - cx, yn - cy);
  if (d > radius) return null;
  if (d < radius * 0.55) return [0.01, 0.01, 0.015];
  return mix(iris, [0.02, 0.02, 0.03], smoothstep(radius * 0.8, radius, d));
}

const ARCHER_SECTIONS: SectionKey[] = [
  { t: 0, top: 0.05, bottom: -0.03, halfWidth: 0.02 },
  { t: 0.05, top: 0.1, bottom: -0.06, halfWidth: 0.06 },
  { t: 0.15, top: 0.17, bottom: -0.12, halfWidth: 0.1 },
  { t: 0.3, top: 0.2, bottom: -0.19, halfWidth: 0.115 },
  { t: 0.5, top: 0.2, bottom: -0.19, halfWidth: 0.11 },
  { t: 0.7, top: 0.15, bottom: -0.14, halfWidth: 0.08 },
  { t: 0.85, top: 0.1, bottom: -0.09, halfWidth: 0.055 },
  { t: 1, top: 0.075, bottom: -0.07, halfWidth: 0.04 },
];

/** Banded archerfish, painted from the species pattern; colours and bar layout read off the Vassil and Pericard photos, no photo pixels reused. */
export function paintArcherfish(tn: number, yn: number): Rgb {
  const p = locate(ARCHER_SECTIONS, tn, yn);
  const silver: Rgb = [0.62, 0.64, 0.5];
  const belly: Rgb = [0.88, 0.88, 0.8];
  const dark: Rgb = [0.05, 0.06, 0.06];
  const fin: Rgb = [0.55, 0.55, 0.38];
  if (p.fin) {
    const out = p.h > 1 ? p.h - 1 : p.h < 0 ? -p.h : 0;
    if (p.tn > 1) return mix(fin, [0.75, 0.68, 0.35], 0.5);
    return mix(fin, [0.08, 0.08, 0.07], smoothstep(0.15, 0.5, out) * 0.8);
  }
  let colour = mix(belly, silver, smoothstep(0.15, 0.6, p.h));
  colour = mix(colour, [0.3, 0.32, 0.25], smoothstep(0.8, 1, p.h) * 0.6);
  const bars = [0.2, 0.34, 0.48, 0.62, 0.78, 0.93];
  let bar = 0;
  for (const [i, centre] of bars.entries()) {
    const reach = i === bars.length - 1 ? 0.15 : 0.3 + 0.05 * (i % 2);
    const lean = (p.h - 0.5) * 0.04;
    bar = Math.max(
      bar,
      band(p.tn + lean, centre, 0.035 + 0.004 * i, 0.012) *
        smoothstep(1 - reach, 1 - reach + 0.25, p.h + 0.05),
    );
  }
  colour = mix(colour, dark, bar * 0.92);
  colour = mix(
    colour,
    [colour[0] * 0.92, colour[1] * 0.92, colour[2] * 0.88],
    noise(Math.floor(p.tn * 220), Math.floor(p.h * 60)) * 0.5,
  );
  const gill = band(p.tn - (0.5 - p.h) * 0.05, 0.2, 0.004, 0.003);
  colour = mix(colour, [0.2, 0.22, 0.18], gill * 0.5 * (1 - bar));
  const eye = eyeSpot(tn, yn, 0.1, 0.075, 0.032, [0.6, 0.5, 0.2]);
  return eye ?? colour;
}

const MONO_SECTIONS: SectionKey[] = [
  { t: 0, top: 0.03, bottom: -0.05, halfWidth: 0.015 },
  { t: 0.05, top: 0.15, bottom: -0.15, halfWidth: 0.04 },
  { t: 0.2, top: 0.3, bottom: -0.27, halfWidth: 0.08 },
  { t: 0.4, top: 0.4, bottom: -0.38, halfWidth: 0.09 },
  { t: 0.55, top: 0.36, bottom: -0.35, halfWidth: 0.085 },
  { t: 0.75, top: 0.18, bottom: -0.17, halfWidth: 0.06 },
  { t: 0.9, top: 0.13, bottom: -0.12, halfWidth: 0.04 },
  { t: 1, top: 0.08, bottom: -0.08, halfWidth: 0.03 },
];

/** Silver mono, painted from the species pattern (Shetty and Khauv photos), no photo pixels reused. */
export function paintMono(tn: number, yn: number): Rgb {
  const p = locate(MONO_SECTIONS, tn, yn);
  const silver: Rgb = [0.78, 0.8, 0.76];
  const back: Rgb = [0.5, 0.52, 0.4];
  const yellow: Rgb = [0.88, 0.7, 0.18];
  if (p.tn > 1) return mix(yellow, [0.95, 0.82, 0.4], smoothstep(1, 1.3, p.tn));
  if (p.fin) {
    const top = p.h > 1;
    const out = top ? p.h - 1 : -p.h;
    const lead = smoothstep(0.1, 0.5, p.tn) * (1 - smoothstep(0.6, 0.95, p.tn));
    let colour = mix(
      mix(yellow, [0.72, 0.64, 0.4], 0.5),
      [0.1, 0.1, 0.08],
      smoothstep(0.35, 0.9, out) * 0.8 * lead,
    );
    if (!top)
      colour = mix(
        colour,
        [0.04, 0.04, 0.04],
        smoothstep(0.55, 0.85, p.tn) * smoothstep(0.1, 0.3, out) * 0.8,
      );
    return colour;
  }
  let colour = mix([0.9, 0.9, 0.86], silver, smoothstep(0.1, 0.5, p.h));
  colour = mix(colour, back, smoothstep(0.7, 1, p.h) * 0.8);
  colour = mix(
    colour,
    [0.5, 0.5, 0.45],
    noise(Math.floor(p.tn * 260), Math.floor(p.h * 80)) * 0.18,
  );
  const eyeBar = band(p.tn + (p.h - 0.5) * 0.05, 0.13, 0.016, 0.01);
  colour = mix(colour, [0.08, 0.07, 0.06], eyeBar * 0.9);
  const rim = smoothstep(0.82, 1, p.tn) * smoothstep(0.55, 0.9, p.h);
  colour = mix(colour, yellow, rim * 0.5);
  const eye = eyeSpot(tn, yn, 0.075, 0.015, 0.03, [0.78, 0.74, 0.55]);
  return eye ?? colour;
}

const GOBY_SECTIONS: SectionKey[] = [
  { t: 0, top: 0.07, bottom: -0.03, halfWidth: 0.03 },
  { t: 0.06, top: 0.11, bottom: -0.07, halfWidth: 0.08 },
  { t: 0.2, top: 0.13, bottom: -0.09, halfWidth: 0.095 },
  { t: 0.4, top: 0.13, bottom: -0.09, halfWidth: 0.085 },
  { t: 0.6, top: 0.11, bottom: -0.08, halfWidth: 0.07 },
  { t: 0.8, top: 0.09, bottom: -0.065, halfWidth: 0.055 },
  { t: 1, top: 0.07, bottom: -0.05, halfWidth: 0.04 },
];

/** Bumblebee goby, painted from the species pattern: black bands on yellow, clear fins (Lisitsyn photos, no pixels reused). */
export function paintBumblebeeGoby(tn: number, yn: number): Rgb {
  const p = locate(GOBY_SECTIONS, tn, yn);
  const yellow: Rgb = [0.95, 0.72, 0.1];
  const black: Rgb = [0.025, 0.02, 0.02];
  const clear: Rgb = [0.82, 0.84, 0.82];
  if (p.tn > 1) {
    const root = 1 - smoothstep(1, 1.08, p.tn);
    return mix(clear, black, root * 0.6);
  }
  if (p.fin) {
    const dorsalBlack = p.h > 1 && p.tn > 0.3 && p.tn < 0.45 ? 0.85 : 0;
    return mix(clear, black, dorsalBlack);
  }
  let colour = mix([0.98, 0.88, 0.5], yellow, smoothstep(0.1, 0.5, p.h));
  const bandMask = Math.max(
    band(p.tn, 0.28, 0.06, 0.02),
    band(p.tn, 0.54, 0.05, 0.02),
    band(p.tn, 0.9, 0.035, 0.015),
    1 - smoothstep(0.07, 0.11, p.tn),
  );
  colour = mix(colour, black, bandMask * 0.95);
  const eye = eyeSpot(tn, yn, 0.075, 0.07, 0.025, [0.2, 0.15, 0.1]);
  return eye ?? colour;
}

const CHROMIDE_SECTIONS: SectionKey[] = [
  { t: 0, top: 0.06, bottom: -0.06, halfWidth: 0.03 },
  { t: 0.08, top: 0.17, bottom: -0.15, halfWidth: 0.07 },
  { t: 0.25, top: 0.27, bottom: -0.23, halfWidth: 0.11 },
  { t: 0.45, top: 0.28, bottom: -0.22, halfWidth: 0.115 },
  { t: 0.65, top: 0.23, bottom: -0.17, halfWidth: 0.09 },
  { t: 0.85, top: 0.15, bottom: -0.12, halfWidth: 0.06 },
  { t: 1, top: 0.1, bottom: -0.08, halfWidth: 0.04 },
];

/** Orange chromide, painted from the species description: olive-gold body with orange freckles, faint dark bars, a black flank blotch, orange fins. */
export function paintChromide(tn: number, yn: number): Rgb {
  const p = locate(CHROMIDE_SECTIONS, tn, yn);
  const gold: Rgb = [0.72, 0.62, 0.22];
  const orange: Rgb = [0.92, 0.45, 0.08];
  const dark: Rgb = [0.1, 0.09, 0.05];
  if (p.tn > 1) return mix([0.85, 0.5, 0.15], [0.9, 0.58, 0.2], smoothstep(1, 1.25, p.tn));
  if (p.fin) {
    const rim = p.h > 1 ? smoothstep(0.6, 1, p.h - 1) * 0.5 : 0;
    const spot = noise(Math.floor(tn * 90), Math.floor(yn * 90)) > 0.8 ? 0.35 : 0;
    return mix(mix(orange, [0.95, 0.6, 0.2], spot), dark, rim);
  }
  let colour = mix([0.9, 0.78, 0.5], gold, smoothstep(0.1, 0.65, p.h));
  const speckle = noise(Math.floor(p.tn * 190), Math.floor(p.h * 55)) > 0.84 ? 0.75 : 0;
  colour = mix(colour, orange, speckle * smoothstep(0.15, 0.7, p.h));
  const bars = Math.max(
    ...[0.22, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82].map((c) => band(p.tn, c, 0.022, 0.012)),
  );
  colour = mix(colour, [0.3, 0.26, 0.1], bars * 0.5 * smoothstep(0.35, 0.8, p.h));
  const blotch = disc(tn, yn, 0.5, 0.03, 0.04);
  const rootBlotch = disc(tn, yn, 0.93, 0, 0.022);
  colour = mix(colour, dark, Math.max(blotch, rootBlotch * 0.8));
  const eye = eyeSpot(tn, yn, 0.1, 0.07, 0.03, [0.85, 0.5, 0.12]);
  return eye ?? colour;
}

const REFERENCE_NOTE =
  'colour map painted from the species pattern; the reference photos set colours and layout only, no photo pixels are reused';

export const MANGROVE_LOFT_RECIPES: LoftFishRecipe[] = [
  {
    id: 'banded-archerfish',
    species: 'banded-archerfish',
    fallbackLengthM: 0.14,
    roughness: 0.3,
    note: `Toxotes jaculatrix: no model exists, so the body is a procedural loft; ${REFERENCE_NOTE} (Vassil CC0, Pericard CC-BY-4.0 for reference)`,
    texture: {
      kind: 'synthetic',
      ...canvasFor(ARCHER_SECTIONS, 0.36, -0.36),
      references: ['wm-archerfish-vassil', 'wm-archerfish-pericard'],
      paint: paintArcherfish,
    },
    spec: {
      roundness: 2.2,
      membrane: true,
      sections: ARCHER_SECTIONS,
      fins: [
        {
          fin: 'dorsal',
          from: 0.56,
          to: 0.82,
          anchor: 'top',
          shape: [0.04, 0.07, 0.09, 0.11, 0.1, 0.08],
          sweep: 0.55,
        },
        {
          fin: 'anal',
          from: 0.56,
          to: 0.84,
          anchor: 'bottom',
          shape: [0.05, 0.09, 0.11, 0.1, 0.08, 0.05],
          sweep: 0.55,
        },
        {
          fin: 'pelvic',
          from: 0.32,
          to: 0.37,
          anchor: 'side',
          flankHeight: 0.03,
          direction: [0.35, -0.95],
          shape: [0.04, 0.09, 0.06],
          sweep: 0.5,
        },
        {
          fin: 'pectoral',
          from: 0.24,
          to: 0.28,
          anchor: 'side',
          flankHeight: 0.35,
          direction: [0.9, -0.3],
          shape: [0.06, 0.12, 0.09],
          sweep: 0.6,
        },
      ],
      caudal: { shape: [0.17, 0.2, 0.22, 0.2, 0.17], spread: 0.03 },
    },
  },
  {
    id: 'silver-mono',
    species: 'silver-mono',
    fallbackLengthM: 0.14,
    roughness: 0.25,
    note: `Monodactylus argenteus: no model exists, so the body is a procedural loft; ${REFERENCE_NOTE} (Shetty CC0, Khauv CC-BY-4.0 for reference)`,
    texture: {
      kind: 'synthetic',
      ...canvasFor(MONO_SECTIONS, 0.8, -0.78),
      references: ['wm-mono-shetty', 'wm-mono-khauv'],
      paint: paintMono,
    },
    spec: {
      roundness: 2.6,
      membrane: true,
      sections: MONO_SECTIONS,
      fins: [
        {
          fin: 'dorsal',
          from: 0.34,
          to: 0.82,
          anchor: 'top',
          shape: [0.1, 0.3, 0.27, 0.19, 0.12, 0.08],
          sweep: 0.8,
        },
        {
          fin: 'anal',
          from: 0.38,
          to: 0.86,
          anchor: 'bottom',
          shape: [0.1, 0.3, 0.22, 0.15, 0.1, 0.06],
          sweep: 0.7,
        },
        {
          fin: 'pelvic',
          from: 0.24,
          to: 0.3,
          anchor: 'side',
          flankHeight: 0.02,
          direction: [0.3, -0.95],
          shape: [0.04, 0.1, 0.06],
          sweep: 0.6,
        },
        {
          fin: 'pectoral',
          from: 0.19,
          to: 0.24,
          anchor: 'side',
          flankHeight: 0.45,
          direction: [0.9, -0.2],
          shape: [0.04, 0.12, 0.09],
          sweep: 0.5,
        },
      ],
      caudal: { shape: [0.2, 0.25, 0.27, 0.25, 0.2], spread: 0.07 },
    },
  },
  {
    id: 'bumblebee-goby',
    species: 'bumblebee-goby',
    fallbackLengthM: 0.028,
    roughness: 0.4,
    note: `Brachygobius: no model exists, so the body is a procedural loft; ${REFERENCE_NOTE} (Lisitsyn CC-BY-4.0 for reference)`,
    texture: {
      kind: 'synthetic',
      ...canvasFor(GOBY_SECTIONS, 0.3, -0.22, 0.22),
      references: ['wm-bumblebee-lisitsyn-1', 'wm-bumblebee-lisitsyn-2'],
      paint: paintBumblebeeGoby,
    },
    spec: {
      roundness: 2.2,
      membrane: true,
      sections: GOBY_SECTIONS,
      fins: [
        { fin: 'dorsal', from: 0.3, to: 0.42, anchor: 'top', shape: [0.06, 0.1, 0.07], sweep: 0.5 },
        {
          fin: 'dorsal',
          from: 0.5,
          to: 0.74,
          anchor: 'top',
          shape: [0.05, 0.08, 0.08, 0.06, 0.04],
          sweep: 0.4,
        },
        {
          fin: 'anal',
          from: 0.52,
          to: 0.74,
          anchor: 'bottom',
          shape: [0.04, 0.07, 0.07, 0.04],
          sweep: 0.4,
        },
        {
          fin: 'pelvic',
          from: 0.24,
          to: 0.3,
          anchor: 'side',
          flankHeight: 0.02,
          direction: [0.3, -0.95],
          shape: [0.04, 0.09, 0.06],
          sweep: 0.5,
        },
        {
          fin: 'pectoral',
          from: 0.2,
          to: 0.25,
          anchor: 'side',
          flankHeight: 0.35,
          direction: [0.9, -0.3],
          shape: [0.06, 0.15, 0.1],
          sweep: 0.5,
        },
      ],
      caudal: { shape: [0.12, 0.18, 0.2, 0.18, 0.12], spread: 0.02 },
    },
  },
  {
    id: 'orange-chromide',
    species: 'orange-chromide',
    fallbackLengthM: 0.075,
    roughness: 0.35,
    note: 'Etroplus maculatus: no model and no allowed photo, so the body is a procedural loft and the colour map is painted from the species description alone',
    texture: {
      kind: 'synthetic',
      ...canvasFor(CHROMIDE_SECTIONS, 0.45, -0.4),
      paint: paintChromide,
    },
    spec: {
      roundness: 2.3,
      membrane: true,
      sections: CHROMIDE_SECTIONS,
      fins: [
        {
          fin: 'dorsal',
          from: 0.28,
          to: 0.8,
          anchor: 'top',
          shape: [0.04, 0.06, 0.09, 0.12, 0.13, 0.12, 0.1, 0.07, 0.04],
          sweep: 0.5,
        },
        {
          fin: 'anal',
          from: 0.5,
          to: 0.8,
          anchor: 'bottom',
          shape: [0.05, 0.1, 0.12, 0.1, 0.06],
          sweep: 0.5,
        },
        {
          fin: 'pelvic',
          from: 0.3,
          to: 0.36,
          anchor: 'side',
          flankHeight: 0.02,
          direction: [0.3, -0.95],
          shape: [0.05, 0.13, 0.09],
          sweep: 0.6,
        },
        {
          fin: 'pectoral',
          from: 0.22,
          to: 0.26,
          anchor: 'side',
          flankHeight: 0.45,
          direction: [0.9, -0.3],
          shape: [0.06, 0.13, 0.1],
          sweep: 0.5,
        },
      ],
      caudal: { shape: [0.15, 0.2, 0.22, 0.2, 0.15], spread: 0.03 },
    },
  },
];

export const MANGROVE_ENVIRONMENT_RECIPES: EnvironmentRecipe[] = [
  {
    id: 'mangrove-prop-roots',
    kind: 'decor',
    sourceId: 'sketchfab-c32d977c',
    gltf: 'gltf/scene.gltf',
    longestM: 0.3,
    maxTriangles: 4000,
    material: { normalMaxPx: 512 },
    modifications: ['scaled to a 30 cm prop-root cluster', 'origin moved to the base centre'],
  },
  {
    id: 'mangrove-stump',
    kind: 'driftwood',
    sourceId: 'sketchfab-a221abc9',
    gltf: 'gltf/scene.gltf',
    longestM: 0.28,
    maxTriangles: 18000,
    clipBelowFraction: 0.16,
    modifications: [
      'scan ground slab clipped',
      'decimated from 360k triangles',
      'scaled to a 28 cm stump',
    ],
  },
  {
    id: 'mangrove-propagule',
    kind: 'decor',
    sourceId: 'sketchfab-2b81ff20',
    gltf: 'gltf/scene.gltf',
    dropMeshes: /^(?!Object_(2|7)$)/,
    longestM: 0.2,
    maxTriangles: 2800,
    modifications: [
      'single propagule LOD variant kept, leaves and slate removed',
      'decimated from 13.7k triangles',
      'scaled to a 20 cm propagule',
    ],
  },
];

export const MANGROVE_SUBSTRATE_RECIPES: SubstrateRecipe[] = [
  { id: 'brown-mud-03', sourceId: 'polyhaven-brown_mud_03', prefix: 'brown_mud_03' },
];
