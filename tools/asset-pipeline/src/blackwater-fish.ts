import type { FinPalette } from './fin-paint.ts';
import { mix, smooth, type LoftFishRecipe } from './loft-fish.ts';
import { sectionEdges, type SectionKey } from './loft.ts';

type Rgb = [number, number, number];

const TETRA_SECTIONS: SectionKey[] = [
  { t: 0, top: 0.02, bottom: -0.03, halfWidth: 0.02 },
  { t: 0.04, top: 0.06, bottom: -0.07, halfWidth: 0.04 },
  { t: 0.1, top: 0.095, bottom: -0.105, halfWidth: 0.05 },
  { t: 0.2, top: 0.125, bottom: -0.13, halfWidth: 0.056 },
  { t: 0.35, top: 0.14, bottom: -0.145, halfWidth: 0.058 },
  { t: 0.5, top: 0.14, bottom: -0.14, halfWidth: 0.055 },
  { t: 0.65, top: 0.115, bottom: -0.115, halfWidth: 0.047 },
  { t: 0.8, top: 0.085, bottom: -0.085, halfWidth: 0.036 },
  { t: 0.92, top: 0.06, bottom: -0.06, halfWidth: 0.027 },
  { t: 1, top: 0.045, bottom: -0.045, halfWidth: 0.02 },
];

const RUMMY_SECTIONS: SectionKey[] = TETRA_SECTIONS.map((s) => ({
  ...s,
  top: s.top * 0.92,
  bottom: s.bottom * 0.92,
}));

function height(sections: SectionKey[], tn: number, yn: number): number {
  const edges = sectionEdges(sections, Math.min(1, Math.max(0, tn)));
  return (yn - edges.bottom) / Math.max(1e-6, edges.top - edges.bottom);
}

function eyeAt(
  sections: SectionKey[],
  tn: number,
  yn: number,
  at: number,
  h: number,
  radius: number,
  iris: Rgb,
  colour: Rgb,
): Rgb {
  const edges = sectionEdges(sections, at);
  const eyeY = edges.bottom + h * (edges.top - edges.bottom);
  const d = Math.hypot(tn - at, yn - eyeY);
  let out = colour;
  if (d < radius) out = mix(iris, [0.85, 0.88, 0.9], smooth(radius * 0.6, radius, d));
  if (d < radius * 0.62) out = [0.02, 0.02, 0.03];
  return out;
}

export function paintCardinal(tn: number, yn: number): Rgb {
  const h = height(TETRA_SECTIONS, tn, yn);
  const olive: Rgb = [0.2, 0.19, 0.11];
  const glass: Rgb = [0.8, 0.72, 0.64];
  const red: Rgb = [0.82, 0.1, 0.07];
  const deepRed: Rgb = [0.6, 0.03, 0.05];
  const blue: Rgb = [0.1, 0.35, 0.95];
  const teal: Rgb = [0.1, 0.85, 0.75];

  const redZone = smooth(0.1, 0.22, tn) * smooth(0.06, 0.2, h) * (1 - smooth(0.55, 0.6, h));
  let colour = mix(glass, red, redZone);
  colour = mix(
    colour,
    deepRed,
    0.45 * smooth(0.2, 0.34, tn) * smooth(0.25, 0.4, h) * (1 - smooth(0.5, 0.57, h)),
  );
  colour = mix(colour, olive, smooth(0.66, 0.78, h));
  const stripe =
    (1 - smooth(0.04, 0.085, Math.abs(h - 0.64))) *
    smooth(0, 0.05, tn) *
    (1 - smooth(0.9, 0.97, tn));
  colour = mix(colour, mix(blue, teal, 0.45 + 0.25 * Math.sin(tn * 22)), stripe * 0.95);
  return eyeAt(TETRA_SECTIONS, tn, yn, 0.07, 0.56, 0.032, [0.2, 0.7, 0.8], colour);
}

export function paintRummyNose(tn: number, yn: number): Rgb {
  const h = height(RUMMY_SECTIONS, tn, yn);
  const red: Rgb = [0.86, 0.08, 0.1];
  const darkRed: Rgb = [0.55, 0.03, 0.06];
  const silver: Rgb = [0.78, 0.8, 0.74];
  const back: Rgb = [0.42, 0.48, 0.34];
  const belly: Rgb = [0.92, 0.93, 0.9];

  let colour = mix(belly, silver, smooth(0.1, 0.4, h));
  colour = mix(colour, back, smooth(0.62, 0.9, h));
  const head = (1 - smooth(0.15, 0.22, tn)) * smooth(0.08, 0.25, h);
  colour = mix(colour, red, head);
  colour = mix(colour, darkRed, 0.35 * head * smooth(0.5, 0.9, h));
  return eyeAt(RUMMY_SECTIONS, tn, yn, 0.075, 0.58, 0.03, [0.9, 0.2, 0.2], colour);
}

const APISTO_MALE_SECTIONS: SectionKey[] = [
  { t: 0, top: 0.01, bottom: -0.01, halfWidth: 0.02 },
  { t: 0.02, top: 0.046, bottom: -0.025, halfWidth: 0.045 },
  { t: 0.06, top: 0.103, bottom: -0.054, halfWidth: 0.07 },
  { t: 0.12, top: 0.142, bottom: -0.086, halfWidth: 0.09 },
  { t: 0.2, top: 0.17, bottom: -0.112, halfWidth: 0.1 },
  { t: 0.3, top: 0.188, bottom: -0.133, halfWidth: 0.105 },
  { t: 0.4, top: 0.193, bottom: -0.146, halfWidth: 0.105 },
  { t: 0.5, top: 0.178, bottom: -0.16, halfWidth: 0.1 },
  { t: 0.6, top: 0.154, bottom: -0.159, halfWidth: 0.095 },
  { t: 0.7, top: 0.13, bottom: -0.141, halfWidth: 0.085 },
  { t: 0.8, top: 0.106, bottom: -0.11, halfWidth: 0.07 },
  { t: 0.9, top: 0.077, bottom: -0.079, halfWidth: 0.055 },
  { t: 1, top: 0.045, bottom: -0.046, halfWidth: 0.035 },
];

const APISTO_FEMALE_SECTIONS: SectionKey[] = APISTO_MALE_SECTIONS.map((s) => ({
  ...s,
  top: s.top * 0.9,
  bottom: s.bottom * 0.9,
  halfWidth: s.halfWidth * 0.92,
}));

export function paintApistoFemale(tn: number, yn: number): Rgb {
  const h = height(APISTO_FEMALE_SECTIONS, tn, yn);
  const yellow: Rgb = [0.93, 0.76, 0.22];
  const tan: Rgb = [0.72, 0.6, 0.34];
  const cream: Rgb = [0.93, 0.88, 0.7];
  const black: Rgb = [0.04, 0.035, 0.03];

  let colour = mix(cream, yellow, smooth(0.12, 0.5, h));
  colour = mix(colour, tan, smooth(0.62, 0.9, h) * 0.8);
  const scales = 0.5 + 0.5 * Math.sin(tn * 150) * Math.sin(h * 26);
  colour = mix(colour, mix(colour, tan, 0.5), 0.18 * scales);
  const band =
    (1 - smooth(0.05, 0.1, Math.abs(h - 0.5))) * smooth(0, 0.03, tn) * (1 - smooth(0.93, 0.99, tn));
  colour = mix(colour, black, band * 0.92);
  const spot = Math.hypot((tn - 0.97) * 1.2, (h - 0.5) * 0.35);
  colour = mix(colour, black, 1 - smooth(0.02, 0.05, spot));
  return eyeAt(APISTO_FEMALE_SECTIONS, tn, yn, 0.075, 0.6, 0.032, [0.85, 0.6, 0.2], colour);
}

const CLEAR: Rgb = [196, 200, 205];

function clearFin(seed: number): FinPalette['pectoral'] {
  return {
    root: CLEAR,
    tip: [222, 226, 230],
    rays: 7,
    rayDepth: 0.2,
    opacity: { root: 0.4, tip: 0.1 },
    seed,
  };
}

const CARDINAL_FINS: FinPalette = {
  caudal: {
    root: [175, 120, 110],
    tip: [210, 190, 190],
    rays: 14,
    rayDepth: 0.25,
    opacity: { root: 0.6, tip: 0.2 },
    seed: 1,
  },
  dorsal: { ...clearFin(2), rays: 9, opacity: { root: 0.5, tip: 0.15 } },
  anal: {
    root: [200, 70, 60],
    tip: [225, 170, 160],
    rays: 12,
    rayDepth: 0.25,
    opacity: { root: 0.75, tip: 0.25 },
    seed: 3,
  },
  pectoral: clearFin(4),
  pelvic: { ...clearFin(5), root: [225, 200, 195] },
};

const RUMMY_FINS: FinPalette = {
  caudal: {
    root: [200, 205, 200],
    tip: [235, 238, 235],
    rays: 14,
    rayDepth: 0.15,
    opacity: { root: 0.45, tip: 0.35 },
    bands: [
      { from: 0.22, to: 0.42, colour: [14, 14, 18], opacity: 0.95 },
      { from: 0.42, to: 0.58, colour: [246, 246, 244], opacity: 0.95 },
      { from: 0.58, to: 0.74, colour: [14, 14, 18], opacity: 0.95 },
      { from: 0.74, to: 0.92, colour: [246, 246, 244], opacity: 0.95 },
    ],
    seed: 1,
  },
  dorsal: { ...clearFin(2), rays: 9, opacity: { root: 0.5, tip: 0.15 } },
  anal: { ...clearFin(3), rays: 11, opacity: { root: 0.5, tip: 0.15 } },
  pectoral: clearFin(4),
  pelvic: { ...clearFin(5), root: [215, 120, 110] },
};

const PENCIL_MALE_FINS: FinPalette = {
  caudal: {
    rootFromPhoto: true,
    root: [140, 140, 140],
    tip: [205, 208, 212],
    rays: 18,
    rayDepth: 0.3,
    opacity: { root: 0.85, tip: 0.3 },
    seed: 1,
  },
  dorsal: {
    root: [196, 26, 40],
    tip: [80, 55, 70],
    rim: [200, 200, 208],
    rimStart: 0.82,
    rays: 8,
    rayDepth: 0.35,
    opacity: { root: 0.95, tip: 0.5 },
    seed: 2,
  },
  anal: {
    root: [232, 170, 40],
    tip: [196, 36, 30],
    rim: [40, 16, 16],
    rimStart: 0.75,
    rays: 8,
    rayDepth: 0.3,
    opacity: { root: 0.95, tip: 0.8 },
    seed: 3,
  },
  pectoral: clearFin(4),
  pelvic: { ...clearFin(5), root: [225, 215, 190], opacity: { root: 0.5, tip: 0.2 } },
};

const PENCIL_FEMALE_FINS: FinPalette = {
  caudal: {
    rootFromPhoto: true,
    root: [140, 140, 140],
    tip: [205, 208, 212],
    rays: 18,
    rayDepth: 0.3,
    opacity: { root: 0.8, tip: 0.2 },
    seed: 1,
  },
  dorsal: {
    root: [210, 22, 32],
    tip: [190, 190, 196],
    rays: 8,
    rayDepth: 0.3,
    opacity: { root: 0.97, tip: 0.35 },
    seed: 2,
  },
  anal: {
    root: [215, 30, 34],
    tip: [210, 150, 140],
    rays: 7,
    rayDepth: 0.25,
    opacity: { root: 0.95, tip: 0.5 },
    seed: 3,
  },
  pectoral: clearFin(4),
  pelvic: {
    root: [212, 28, 34],
    tip: [215, 150, 140],
    rays: 5,
    rayDepth: 0.25,
    opacity: { root: 0.95, tip: 0.5 },
    seed: 5,
  },
};

const APISTO_MALE_FINS: FinPalette = {
  caudal: {
    root: [215, 190, 70],
    tip: [238, 212, 100],
    rim: [196, 150, 50],
    rimStart: 0.8,
    rays: 14,
    rayDepth: 0.3,
    opacity: { root: 0.9, tip: 0.55 },
    seed: 1,
  },
  dorsal: {
    root: [190, 112, 72],
    tip: [240, 208, 92],
    rim: [200, 64, 44],
    rimStart: 0.8,
    rays: 16,
    rayDepth: 0.3,
    opacity: { root: 0.85, tip: 0.5 },
    seed: 2,
  },
  anal: {
    root: [215, 195, 110],
    tip: [238, 214, 100],
    rim: [212, 170, 60],
    rimStart: 0.8,
    rays: 10,
    rayDepth: 0.3,
    opacity: { root: 0.8, tip: 0.45 },
    seed: 3,
  },
  pectoral: clearFin(4),
  pelvic: {
    root: [200, 215, 225],
    tip: [235, 242, 245],
    rays: 4,
    rayDepth: 0.25,
    opacity: { root: 0.75, tip: 0.4 },
    seed: 5,
  },
};

const APISTO_FEMALE_FINS: FinPalette = {
  caudal: {
    root: [225, 195, 70],
    tip: [235, 215, 120],
    rays: 14,
    rayDepth: 0.3,
    opacity: { root: 0.85, tip: 0.4 },
    seed: 1,
  },
  dorsal: {
    root: [228, 190, 64],
    tip: [235, 210, 110],
    rim: [40, 30, 20],
    rimStart: 0.82,
    rays: 14,
    rayDepth: 0.3,
    opacity: { root: 0.85, tip: 0.5 },
    seed: 2,
  },
  anal: {
    root: [230, 195, 80],
    tip: [235, 215, 120],
    rays: 9,
    rayDepth: 0.3,
    opacity: { root: 0.8, tip: 0.4 },
    seed: 3,
  },
  pectoral: clearFin(4),
  pelvic: {
    root: [230, 195, 80],
    tip: [236, 220, 140],
    rim: [30, 25, 20],
    rimStart: 0.85,
    rays: 4,
    rayDepth: 0.25,
    opacity: { root: 0.8, tip: 0.5 },
    seed: 5,
  },
};

const TETRA_FINS: LoftFishRecipe['spec']['fins'] = [
  {
    fin: 'dorsal',
    from: 0.4,
    to: 0.54,
    anchor: 'top',
    shape: [0.05, 0.09, 0.1, 0.08, 0.04],
    sweep: 0.8,
  },
  {
    fin: 'anal',
    from: 0.5,
    to: 0.8,
    anchor: 'bottom',
    shape: [0.04, 0.07, 0.08, 0.07, 0.06, 0.04],
    sweep: 0.7,
  },
  {
    fin: 'pelvic',
    from: 0.38,
    to: 0.46,
    anchor: 'side',
    flankHeight: 0.05,
    direction: [0.3, -0.95],
    shape: [0.03, 0.08, 0.1, 0.05],
    sweep: 0.5,
  },
  {
    fin: 'pectoral',
    from: 0.2,
    to: 0.26,
    anchor: 'side',
    flankHeight: 0.35,
    direction: [0.9, -0.3],
    shape: [0.03, 0.08, 0.1, 0.06],
    sweep: 0.6,
  },
];

function syntheticTetra(
  paint: (tn: number, yn: number) => Rgb,
  references: string[],
  finPalette: FinPalette,
): LoftFishRecipe['texture'] {
  return {
    finPalette,
    kind: 'synthetic',
    width: 1280,
    height: 768,
    snoutPixel: [60, 384],
    tailPixel: [960, 384],
    references,
    paint,
  };
}

const PENCIL_FINS: LoftFishRecipe['spec']['fins'] = [
  {
    fin: 'dorsal',
    from: 0.5,
    to: 0.68,
    anchor: 'top',
    shape: [0.04, 0.1, 0.13, 0.11, 0.05],
    sweep: 0.5,
  },
  {
    fin: 'anal',
    from: 0.7,
    to: 0.85,
    anchor: 'bottom',
    shape: [0.04, 0.07, 0.07, 0.04],
    sweep: 0.8,
  },
  {
    fin: 'pelvic',
    from: 0.42,
    to: 0.5,
    anchor: 'side',
    flankHeight: 0.05,
    direction: [0.3, -0.95],
    shape: [0.03, 0.08, 0.09, 0.04],
    sweep: 0.5,
  },
  {
    fin: 'pectoral',
    from: 0.2,
    to: 0.27,
    anchor: 'side',
    flankHeight: 0.35,
    direction: [0.9, -0.3],
    shape: [0.03, 0.07, 0.09, 0.05],
    sweep: 0.6,
  },
];

const PENCIL_CAUDAL = {
  shape: [0.1, 0.17, 0.2, 0.19, 0.15, 0.19, 0.2, 0.17, 0.1],
  spread: 0.1,
};

const APISTO_FINS = (scale: number): LoftFishRecipe['spec']['fins'] => [
  {
    fin: 'dorsal',
    from: 0.28,
    to: 0.98,
    anchor: 'top',
    shape: [0.06, 0.08, 0.09, 0.1, 0.1, 0.11, 0.12, 0.14, 0.15, 0.1].map((v) => v * scale),
    sweep: 0.9,
  },
  {
    fin: 'anal',
    from: 0.66,
    to: 0.98,
    anchor: 'bottom',
    shape: [0.05, 0.08, 0.1, 0.1, 0.09, 0.06].map((v) => v * scale),
    sweep: 0.8,
  },
  {
    fin: 'pelvic',
    from: 0.28,
    to: 0.36,
    anchor: 'side',
    flankHeight: 0.05,
    direction: [0.3, -0.95],
    shape: [0.05, 0.14, 0.15, 0.1, 0.05].map((v) => v * scale),
    sweep: 0.4,
  },
  {
    fin: 'pectoral',
    from: 0.26,
    to: 0.33,
    anchor: 'side',
    flankHeight: 0.35,
    direction: [0.9, -0.3],
    shape: [0.03, 0.07, 0.09, 0.06],
    sweep: 0.6,
  },
];

const APISTO_CAUDAL = {
  shape: [0.1, 0.17, 0.21, 0.23, 0.23, 0.23, 0.21, 0.17, 0.1],
  spread: 0.1,
};

export const BLACKWATER_FISH_RECIPES: LoftFishRecipe[] = [
  {
    id: 'cardinal-tetra',
    species: 'cardinal-tetra',
    fallbackLengthM: 0.0342,
    roughness: 0.3,
    note: 'Paracheirodon axelrodi colours painted procedurally by eye from a CC0 photograph (Henrique Pinto); no pixels are reused',
    texture: syntheticTetra(paintCardinal, ['wm-cardinal-vicente'], CARDINAL_FINS),
    spec: {
      membrane: true,
      roundness: 2.1,
      sections: TETRA_SECTIONS,
      fins: TETRA_FINS,
      caudal: { shape: [0.1, 0.15, 0.2, 0.2, 0.15, 0.2, 0.2, 0.15, 0.1], spread: 0.08 },
    },
  },
  {
    id: 'rummy-nose-tetra',
    species: 'rummy-nose-tetra',
    fallbackLengthM: 0.036,
    roughness: 0.3,
    note: 'Petitella bleheri (sold as rummy-nose) painted procedurally by eye from a CC-BY photograph (Donar Reiskoffer); no pixels are reused',
    texture: syntheticTetra(paintRummyNose, ['wm-rummynose-reiskoffer'], RUMMY_FINS),
    spec: {
      membrane: true,
      roundness: 2.1,
      sections: RUMMY_SECTIONS,
      fins: TETRA_FINS,
      caudal: { shape: [0.1, 0.2, 0.26, 0.2, 0.14, 0.2, 0.26, 0.2, 0.1], spread: 0.09 },
    },
  },
  {
    id: 'apistogramma-hongsloi',
    species: 'apistogramma-hongsloi',
    fallbackLengthM: 0.034,
    roughness: 0.4,
    note: 'Female Apistogramma hongsloi painted procedurally by eye from CC-BY photographs (SamaelGMO); no pixels are reused',
    texture: {
      kind: 'synthetic',
      width: 1280,
      height: 768,
      snoutPixel: [60, 384],
      tailPixel: [960, 384],
      references: ['wm-apistogramma-hongsloi-pair'],
      finPalette: APISTO_FEMALE_FINS,
      paint: paintApistoFemale,
    },
    spec: {
      membrane: true,
      roundness: 2.2,
      sections: APISTO_FEMALE_SECTIONS,
      fins: APISTO_FINS(0.85),
      caudal: APISTO_CAUDAL,
    },
  },
  {
    id: 'apistogramma-hongsloi-male',
    species: 'apistogramma-hongsloi',
    fallbackLengthM: 0.05,
    lengthFactor: 0.05 / 0.03,
    roughness: 0.4,
    note: 'Male Apistogramma hongsloi by SamaelGMO (CC-BY-4.0), side view projected onto the loft; fins painted as translucent membranes',
    texture: {
      kind: 'photo',
      sourceId: 'wm-apistogramma-hongsloi-male',
      file: 'original.jpg',
      crop: { left: 4150, top: 2950, width: 3100, height: 1850 },
      snoutPixel: [4271, 3700],
      tailPixel: [6602, 3935],
      finPalette: APISTO_MALE_FINS,
    },
    spec: {
      membrane: true,
      roundness: 2.2,
      sections: APISTO_MALE_SECTIONS,
      fins: APISTO_FINS(1),
      caudal: APISTO_CAUDAL,
    },
  },
  {
    id: 'dwarf-pencilfish-male',
    species: 'dwarf-pencilfish',
    fallbackLengthM: 0.0292,
    roughness: 0.35,
    note: 'Male Nannostomus marginatus by D.W. (CC0), side view projected onto the loft with the photographed body fitted to the species proportions',
    texture: {
      kind: 'photo',
      sourceId: 'wm-nannostomus-marginatus-male',
      file: 'original.jpg',
      crop: { left: 330, top: 270, width: 2300, height: 1030 },
      snoutPixel: [396, 548],
      tailPixel: [2213, 833],
      finPalette: PENCIL_MALE_FINS,
      photoSections: [
        { t: 0, top: 0.012, bottom: -0.012, halfWidth: 0.02 },
        { t: 0.02, top: 0.026, bottom: -0.039, halfWidth: 0.03 },
        { t: 0.06, top: 0.047, bottom: -0.068, halfWidth: 0.04 },
        { t: 0.12, top: 0.064, bottom: -0.097, halfWidth: 0.045 },
        { t: 0.2, top: 0.081, bottom: -0.116, halfWidth: 0.05 },
        { t: 0.3, top: 0.093, bottom: -0.13, halfWidth: 0.052 },
        { t: 0.4, top: 0.092, bottom: -0.137, halfWidth: 0.052 },
        { t: 0.5, top: 0.085, bottom: -0.14, halfWidth: 0.05 },
        { t: 0.6, top: 0.074, bottom: -0.135, halfWidth: 0.047 },
        { t: 0.7, top: 0.062, bottom: -0.12, halfWidth: 0.042 },
        { t: 0.8, top: 0.055, bottom: -0.105, halfWidth: 0.036 },
        { t: 0.9, top: 0.056, bottom: -0.088, halfWidth: 0.03 },
        { t: 1, top: 0.036, bottom: -0.043, halfWidth: 0.02 },
      ],
    },
    spec: {
      membrane: true,
      roundness: 2.2,
      sections: [
        { t: 0, top: 0.012, bottom: -0.012, halfWidth: 0.02 },
        { t: 0.02, top: 0.022, bottom: -0.034, halfWidth: 0.03 },
        { t: 0.06, top: 0.04, bottom: -0.058, halfWidth: 0.04 },
        { t: 0.12, top: 0.055, bottom: -0.082, halfWidth: 0.045 },
        { t: 0.2, top: 0.068, bottom: -0.098, halfWidth: 0.05 },
        { t: 0.3, top: 0.078, bottom: -0.108, halfWidth: 0.052 },
        { t: 0.4, top: 0.08, bottom: -0.113, halfWidth: 0.052 },
        { t: 0.5, top: 0.075, bottom: -0.113, halfWidth: 0.05 },
        { t: 0.6, top: 0.067, bottom: -0.108, halfWidth: 0.047 },
        { t: 0.7, top: 0.058, bottom: -0.098, halfWidth: 0.042 },
        { t: 0.8, top: 0.05, bottom: -0.085, halfWidth: 0.036 },
        { t: 0.9, top: 0.045, bottom: -0.07, halfWidth: 0.03 },
        { t: 1, top: 0.032, bottom: -0.04, halfWidth: 0.02 },
      ],
      fins: PENCIL_FINS,
      caudal: PENCIL_CAUDAL,
    },
  },
  {
    id: 'dwarf-pencilfish',
    species: 'dwarf-pencilfish',
    fallbackLengthM: 0.0292,
    roughness: 0.35,
    note: 'Female Nannostomus marginatus by D.W. (CC0), side view projected onto the loft with the photographed body fitted to the species proportions',
    texture: {
      kind: 'photo',
      sourceId: 'wm-nannostomus-marginatus-female',
      file: 'original.jpg',
      crop: { left: 320, top: 380, width: 1350, height: 820 },
      snoutPixel: [335, 912],
      tailPixel: [1520, 865],
      finPalette: PENCIL_FEMALE_FINS,
      photoSections: [
        { t: 0, top: 0.016, bottom: -0.018, halfWidth: 0.02 },
        { t: 0.02, top: 0.034, bottom: -0.038, halfWidth: 0.035 },
        { t: 0.06, top: 0.065, bottom: -0.081, halfWidth: 0.05 },
        { t: 0.12, top: 0.097, bottom: -0.138, halfWidth: 0.06 },
        { t: 0.2, top: 0.129, bottom: -0.189, halfWidth: 0.065 },
        { t: 0.3, top: 0.158, bottom: -0.227, halfWidth: 0.068 },
        { t: 0.4, top: 0.178, bottom: -0.246, halfWidth: 0.07 },
        { t: 0.5, top: 0.189, bottom: -0.244, halfWidth: 0.07 },
        { t: 0.6, top: 0.184, bottom: -0.229, halfWidth: 0.065 },
        { t: 0.7, top: 0.163, bottom: -0.199, halfWidth: 0.058 },
        { t: 0.8, top: 0.144, bottom: -0.162, halfWidth: 0.048 },
        { t: 0.9, top: 0.119, bottom: -0.116, halfWidth: 0.038 },
        { t: 1, top: 0.086, bottom: -0.068, halfWidth: 0.026 },
      ],
    },
    spec: {
      membrane: true,
      roundness: 2.2,
      sections: [
        { t: 0, top: 0.012, bottom: -0.012, halfWidth: 0.02 },
        { t: 0.02, top: 0.025, bottom: -0.028, halfWidth: 0.035 },
        { t: 0.06, top: 0.045, bottom: -0.055, halfWidth: 0.05 },
        { t: 0.12, top: 0.065, bottom: -0.09, halfWidth: 0.06 },
        { t: 0.2, top: 0.082, bottom: -0.115, halfWidth: 0.065 },
        { t: 0.3, top: 0.1, bottom: -0.14, halfWidth: 0.068 },
        { t: 0.4, top: 0.11, bottom: -0.152, halfWidth: 0.07 },
        { t: 0.5, top: 0.115, bottom: -0.15, halfWidth: 0.07 },
        { t: 0.6, top: 0.11, bottom: -0.14, halfWidth: 0.065 },
        { t: 0.7, top: 0.098, bottom: -0.12, halfWidth: 0.058 },
        { t: 0.8, top: 0.085, bottom: -0.096, halfWidth: 0.048 },
        { t: 0.9, top: 0.07, bottom: -0.07, halfWidth: 0.038 },
        { t: 1, top: 0.045, bottom: -0.04, halfWidth: 0.026 },
      ],
      fins: [
        {
          fin: 'dorsal',
          from: 0.5,
          to: 0.62,
          anchor: 'top',
          shape: [0.05, 0.12, 0.14, 0.08],
          sweep: 0.3,
        },
        {
          fin: 'anal',
          from: 0.72,
          to: 0.88,
          anchor: 'bottom',
          shape: [0.04, 0.07, 0.07, 0.04],
          sweep: 0.8,
        },
        {
          fin: 'pelvic',
          from: 0.55,
          to: 0.66,
          anchor: 'side',
          flankHeight: 0.05,
          direction: [0.3, -0.95],
          shape: [0.04, 0.09, 0.09, 0.04],
          sweep: 0.5,
        },
        {
          fin: 'pectoral',
          from: 0.2,
          to: 0.26,
          anchor: 'side',
          flankHeight: 0.35,
          direction: [0.9, -0.3],
          shape: [0.03, 0.07, 0.09, 0.05],
          sweep: 0.6,
        },
      ],
      caudal: PENCIL_CAUDAL,
    },
  },
];
