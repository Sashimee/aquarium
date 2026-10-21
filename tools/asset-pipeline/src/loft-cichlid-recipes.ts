import type { LoftFishRecipe } from './loft-fish.ts';
import { sectionEdges, type LoftSpec, type SectionKey } from './loft.ts';

type Rgb = [number, number, number];

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const MBUNA_SECTIONS: SectionKey[] = [
  { t: 0, top: 0.02, bottom: -0.03, halfWidth: 0.01 },
  { t: 0.1, top: 0.079, bottom: -0.064, halfWidth: 0.045 },
  { t: 0.2, top: 0.152, bottom: -0.117, halfWidth: 0.07 },
  { t: 0.3, top: 0.174, bottom: -0.145, halfWidth: 0.08 },
  { t: 0.4, top: 0.17, bottom: -0.156, halfWidth: 0.082 },
  { t: 0.5, top: 0.16, bottom: -0.159, halfWidth: 0.08 },
  { t: 0.6, top: 0.141, bottom: -0.14, halfWidth: 0.075 },
  { t: 0.7, top: 0.118, bottom: -0.1, halfWidth: 0.066 },
  { t: 0.8, top: 0.089, bottom: -0.065, halfWidth: 0.055 },
  { t: 0.9, top: 0.07, bottom: -0.048, halfWidth: 0.045 },
  { t: 1, top: 0.063, bottom: -0.055, halfWidth: 0.035 },
];

const MBUNA_SPEC: Omit<LoftSpec, 'standardLengthM'> = {
  roundness: 2.3,
  sections: MBUNA_SECTIONS,
  fins: [
    {
      fin: 'dorsal',
      from: 0.28,
      to: 0.96,
      anchor: 'top',
      shape: [0.03, 0.05, 0.065, 0.07, 0.07, 0.07, 0.065, 0.06, 0.05, 0.04],
      sweep: 0.5,
    },
    {
      fin: 'anal',
      from: 0.72,
      to: 0.97,
      anchor: 'bottom',
      shape: [0.03, 0.07, 0.1, 0.08, 0.05],
      sweep: 0.6,
    },
    {
      fin: 'pelvic',
      from: 0.3,
      to: 0.36,
      anchor: 'side',
      flankHeight: 0.05,
      direction: [0.35, -0.9],
      shape: [0.03, 0.07, 0.08, 0.04],
      sweep: 0.5,
    },
    {
      fin: 'pectoral',
      from: 0.22,
      to: 0.28,
      anchor: 'side',
      flankHeight: 0.4,
      direction: [0.9, -0.3],
      shape: [0.04, 0.1, 0.12, 0.07],
      sweep: 0.6,
    },
  ],
  caudal: { shape: [0.2, 0.23, 0.2, 0.17, 0.2, 0.23, 0.2], spread: 0.086 },
};

function paintMbunaMale(tn: number, yn: number): Rgb {
  const navy: Rgb = [0.04, 0.05, 0.13];
  const pale: Rgb = [0.78, 0.8, 0.62];
  const forehead: Rgb = [0.5, 0.58, 0.7];
  const { top, bottom } = sectionEdges(MBUNA_SECTIONS, Math.min(1, Math.max(0, tn)));
  const outside =
    tn < 0 ? 1 : Math.max(smoothstep(top, top + 0.004, yn), smoothstep(bottom, bottom - 0.004, yn));
  if (tn > 1 || outside > 0.5) {
    const edge = smoothstep(0.04, 0.12, Math.max(yn - top, bottom - yn, tn - 1));
    return mixRgb([0.07, 0.08, 0.2], [0.65, 0.6, 0.25], 0.5 * edge);
  }
  const slope = 0.08 * tn;
  const stripe = (centre: number, width: number): number =>
    1 - smoothstep(width * 0.6, width, Math.abs(yn - (centre - slope)));
  let colour = mixRgb(
    navy,
    pale,
    Math.max(stripe(0.14, 0.018), stripe(0.0, 0.02)) * smoothstep(0.1, 0.16, tn),
  );
  colour = mixRgb(
    colour,
    forehead,
    0.5 * (1 - smoothstep(0.1, 0.16, tn)) * smoothstep(0.02, 0.06, yn),
  );
  colour = mixRgb(colour, [0.12, 0.13, 0.3], 0.5 * smoothstep(-0.05, -0.12, yn));
  const eye = Math.hypot(tn - 0.115, yn - 0.04);
  if (eye < 0.03)
    colour = mixRgb([0.02, 0.02, 0.03], [0.85, 0.8, 0.4], smoothstep(0.02, 0.03, eye));
  return colour;
}

export const CICHLID_LOFT_RECIPES: LoftFishRecipe[] = [
  {
    id: 'labidochromis-caeruleus',
    species: 'labidochromis-caeruleus',
    fallbackLengthM: 0.075,
    roughness: 0.4,
    note: 'Labidochromis caeruleus by Chmee2 (CC-BY-3.0), side view projected onto the loft; fins painted as translucent yellow membranes with the black dorsal and anal margins of the species',
    texture: {
      kind: 'photo',
      sourceId: 'wm-labidochromis-chmee2',
      file: 'original.jpg',
      crop: { left: 900, top: 1050, width: 3400, height: 1500 },
      snoutPixel: [990, 1643],
      tailPixel: [3485, 1947],
      finPalette: {
        caudal: {
          rootFromPhoto: true,
          root: [240, 168, 24],
          tip: [236, 214, 70],
          rim: [200, 190, 60],
          rimStart: 0.8,
          rays: 16,
          rayDepth: 0.25,
          opacity: { root: 1, tip: 0.7 },
          seed: 41,
        },
        dorsal: {
          root: [236, 176, 20],
          tip: [224, 200, 60],
          rim: [14, 12, 10],
          rimStart: 0.55,
          rays: 14,
          rayDepth: 0.3,
          opacity: { root: 1, tip: 0.8 },
          seed: 42,
        },
        anal: {
          root: [30, 26, 20],
          tip: [200, 205, 220],
          rim: [236, 240, 250],
          rimStart: 0.7,
          rays: 10,
          rayDepth: 0.3,
          opacity: { root: 1, tip: 0.75 },
          seed: 43,
        },
        pectoral: {
          root: [236, 184, 36],
          tip: [240, 214, 110],
          rays: 10,
          rayDepth: 0.25,
          opacity: { root: 0.6, tip: 0.2 },
          seed: 44,
        },
        pelvic: {
          root: [236, 184, 36],
          tip: [230, 220, 150],
          rays: 5,
          rayDepth: 0.25,
          opacity: { root: 0.7, tip: 0.35 },
          seed: 45,
        },
      },
    },
    spec: {
      membrane: true,
      roundness: 2.3,
      sections: [
        { t: 0, top: 0.005, bottom: -0.005, halfWidth: 0.01 },
        { t: 0.05, top: 0.07, bottom: -0.047, halfWidth: 0.04 },
        { t: 0.1, top: 0.108, bottom: -0.075, halfWidth: 0.065 },
        { t: 0.15, top: 0.148, bottom: -0.09, halfWidth: 0.08 },
        { t: 0.2, top: 0.18, bottom: -0.1, halfWidth: 0.09 },
        { t: 0.3, top: 0.218, bottom: -0.12, halfWidth: 0.1 },
        { t: 0.4, top: 0.245, bottom: -0.123, halfWidth: 0.1 },
        { t: 0.5, top: 0.25, bottom: -0.119, halfWidth: 0.095 },
        { t: 0.6, top: 0.24, bottom: -0.113, halfWidth: 0.09 },
        { t: 0.7, top: 0.225, bottom: -0.106, halfWidth: 0.082 },
        { t: 0.8, top: 0.2, bottom: -0.096, halfWidth: 0.07 },
        { t: 0.9, top: 0.13, bottom: -0.088, halfWidth: 0.055 },
        { t: 0.95, top: 0.1, bottom: -0.075, halfWidth: 0.045 },
        { t: 1, top: 0.068, bottom: -0.068, halfWidth: 0.035 },
      ],
      fins: [
        {
          fin: 'dorsal',
          from: 0.2,
          to: 0.97,
          anchor: 'top',
          shape: [0.03, 0.035, 0.04, 0.04, 0.04, 0.045, 0.06, 0.09, 0.1, 0.08, 0.04],
          sweep: 0.6,
        },
        {
          fin: 'anal',
          from: 0.4,
          to: 0.96,
          anchor: 'bottom',
          shape: [0.02, 0.025, 0.03, 0.04, 0.06, 0.09, 0.08, 0.04],
          sweep: 0.6,
        },
        {
          fin: 'pelvic',
          from: 0.3,
          to: 0.36,
          anchor: 'side',
          flankHeight: 0.05,
          direction: [0.35, -0.9],
          shape: [0.04, 0.11, 0.13, 0.06],
          sweep: 0.5,
        },
        {
          fin: 'pectoral',
          from: 0.33,
          to: 0.4,
          anchor: 'side',
          flankHeight: 0.4,
          direction: [0.9, -0.3],
          shape: [0.05, 0.15, 0.22, 0.14],
          sweep: 0.6,
        },
      ],
      caudal: {
        shape: [0.22, 0.25, 0.26, 0.25, 0.22, 0.2, 0.22, 0.25, 0.26, 0.25, 0.22],
        spread: 0.1,
      },
    },
  },
  {
    id: 'melanochromis-auratus-female',
    species: 'melanochromis-auratus',
    fallbackLengthM: 0.085,
    roughness: 0.4,
    note: 'Melanochromis auratus female (golden mbuna) by Lee (CC-BY-3.0), side view projected onto the loft; fins painted as translucent membranes',
    texture: {
      kind: 'photo',
      sourceId: 'wm-melanochromis-lee-1',
      file: 'original.jpg',
      crop: { left: 560, top: 800, width: 2640, height: 1050 },
      snoutPixel: [3077, 1497],
      tailPixel: [1107, 1358],
      finPalette: {
        caudal: {
          rootFromPhoto: true,
          root: [225, 225, 200],
          tip: [225, 215, 70],
          rays: 14,
          rayDepth: 0.25,
          opacity: { root: 1, tip: 0.6 },
          seed: 51,
        },
        dorsal: {
          root: [225, 228, 225],
          tip: [220, 210, 80],
          rim: [226, 214, 60],
          rimStart: 0.85,
          rays: 14,
          rayDepth: 0.3,
          opacity: { root: 1, tip: 0.75 },
          seed: 52,
        },
        anal: {
          root: [235, 205, 40],
          tip: [226, 214, 70],
          rays: 10,
          rayDepth: 0.3,
          opacity: { root: 1, tip: 0.6 },
          seed: 53,
        },
        pectoral: {
          root: [225, 220, 160],
          tip: [230, 225, 190],
          rays: 10,
          rayDepth: 0.25,
          opacity: { root: 0.5, tip: 0.2 },
          seed: 54,
        },
        pelvic: {
          root: [235, 215, 90],
          tip: [230, 220, 150],
          rays: 5,
          rayDepth: 0.25,
          opacity: { root: 0.7, tip: 0.35 },
          seed: 55,
        },
      },
    },
    spec: { ...MBUNA_SPEC, membrane: true },
  },
  {
    id: 'melanochromis-auratus-male',
    species: 'melanochromis-auratus',
    fallbackLengthM: 0.085,
    roughness: 0.4,
    note: 'Melanochromis auratus male: no allowed side-view photograph exists, so the colour map is painted from the described pattern (blue-black body, two pale flank stripes) and no photo pixels are reused, so the asset is CC0',
    texture: {
      kind: 'synthetic',
      width: 1400,
      height: 600,
      snoutPixel: [60, 300],
      tailPixel: [1060, 291],
      references: ['wm-melanochromis-5snake5-male', 'wm-melanochromis-5snake5-female'],
      paint: paintMbunaMale,
    },
    spec: MBUNA_SPEC,
  },
  {
    id: 'altolamprologus-calvus',
    species: 'altolamprologus-calvus',
    fallbackLengthM: 0.1,
    roughness: 0.4,
    note: 'Altolamprologus calvus (black calvus) by 5snake5 (CC0), side view projected onto the loft; fins painted as translucent grey membranes with pale blue margins',
    texture: {
      kind: 'photo',
      sourceId: 'wm-altolamprologus-5snake5',
      file: 'original.jpg',
      crop: { left: 400, top: 600, width: 2950, height: 1800 },
      snoutPixel: [502, 1485],
      tailPixel: [2750, 1323],
      finPalette: {
        caudal: {
          rootFromPhoto: true,
          root: [52, 46, 44],
          tip: [70, 70, 80],
          rim: [150, 195, 220],
          rimStart: 0.92,
          rays: 18,
          rayDepth: 0.25,
          opacity: { root: 1, tip: 0.75 },
          seed: 61,
        },
        dorsal: {
          root: [58, 50, 48],
          tip: [74, 72, 80],
          rim: [150, 195, 220],
          rimStart: 0.92,
          rays: 20,
          rayDepth: 0.3,
          opacity: { root: 1, tip: 0.8 },
          seed: 62,
        },
        anal: {
          root: [58, 50, 48],
          tip: [74, 72, 80],
          rim: [150, 195, 220],
          rimStart: 0.92,
          rays: 14,
          rayDepth: 0.3,
          opacity: { root: 1, tip: 0.8 },
          seed: 63,
        },
        pectoral: {
          root: [110, 108, 112],
          tip: [150, 150, 156],
          rays: 10,
          rayDepth: 0.25,
          opacity: { root: 0.5, tip: 0.2 },
          seed: 64,
        },
        pelvic: {
          root: [90, 88, 92],
          tip: [150, 150, 156],
          rays: 5,
          rayDepth: 0.25,
          opacity: { root: 0.7, tip: 0.3 },
          seed: 65,
        },
      },
    },
    spec: {
      membrane: true,
      roundness: 2.3,
      sections: [
        { t: 0, top: 0.01, bottom: -0.025, halfWidth: 0.01 },
        { t: 0.1, top: 0.075, bottom: -0.083, halfWidth: 0.04 },
        { t: 0.2, top: 0.105, bottom: -0.122, halfWidth: 0.06 },
        { t: 0.3, top: 0.16, bottom: -0.117, halfWidth: 0.066 },
        { t: 0.4, top: 0.19, bottom: -0.12, halfWidth: 0.068 },
        { t: 0.5, top: 0.19, bottom: -0.123, halfWidth: 0.068 },
        { t: 0.6, top: 0.15, bottom: -0.125, halfWidth: 0.064 },
        { t: 0.7, top: 0.118, bottom: -0.125, halfWidth: 0.058 },
        { t: 0.8, top: 0.082, bottom: -0.09, halfWidth: 0.05 },
        { t: 0.9, top: 0.052, bottom: -0.075, halfWidth: 0.04 },
        { t: 1, top: 0.034, bottom: -0.04, halfWidth: 0.03 },
      ],
      fins: [
        {
          fin: 'dorsal',
          from: 0.28,
          to: 0.97,
          anchor: 'top',
          shape: [0.04, 0.09, 0.12, 0.12, 0.12, 0.13, 0.14, 0.15, 0.15, 0.14, 0.12],
          sweep: 0.5,
        },
        {
          fin: 'anal',
          from: 0.67,
          to: 0.97,
          anchor: 'bottom',
          shape: [0.03, 0.06, 0.07, 0.07, 0.07, 0.06, 0.04],
          sweep: 0.6,
        },
        {
          fin: 'pelvic',
          from: 0.34,
          to: 0.42,
          anchor: 'side',
          flankHeight: 0.05,
          direction: [0.5, -0.85],
          shape: [0.06, 0.2, 0.26, 0.1],
          sweep: 0.5,
        },
        {
          fin: 'pectoral',
          from: 0.28,
          to: 0.36,
          anchor: 'side',
          flankHeight: 0.4,
          direction: [0.8, -0.5],
          shape: [0.05, 0.1, 0.14, 0.08],
          sweep: 0.6,
        },
      ],
      caudal: { shape: [0.17, 0.21, 0.23, 0.23, 0.23, 0.21, 0.17], spread: 0.11 },
    },
  },
];
