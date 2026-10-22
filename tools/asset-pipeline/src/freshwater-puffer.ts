import type { LoftFishRecipe } from './loft-fish.ts';
import type { SectionKey } from './loft.ts';
import { smoothstep } from './math.ts';
import { band, canvasFor, disc, eyeSpot, locate, mix, noise, ring, type Rgb } from './mangrove.ts';

const PUFFER_SECTIONS: SectionKey[] = [
  { t: 0, top: 0.06, bottom: -0.08, halfWidth: 0.04 },
  { t: 0.06, top: 0.16, bottom: -0.17, halfWidth: 0.11 },
  { t: 0.2, top: 0.22, bottom: -0.23, halfWidth: 0.19 },
  { t: 0.4, top: 0.22, bottom: -0.22, halfWidth: 0.19 },
  { t: 0.6, top: 0.17, bottom: -0.17, halfWidth: 0.14 },
  { t: 0.8, top: 0.11, bottom: -0.1, halfWidth: 0.09 },
  { t: 1, top: 0.08, bottom: -0.07, halfWidth: 0.06 },
];

/** Figure-8 puffer, painted from the species description: olive back, cream belly, two dark rings forming the 8, a black ocellus on the dorsal. */
export function paintFigure8Puffer(tn: number, yn: number): Rgb {
  const p = locate(PUFFER_SECTIONS, tn, yn);
  const olive: Rgb = [0.36, 0.33, 0.13];
  const cream: Rgb = [0.9, 0.86, 0.6];
  const dark: Rgb = [0.07, 0.05, 0.03];
  if (p.tn > 1) return mix([0.5, 0.42, 0.2], [0.78, 0.7, 0.35], smoothstep(1, 1.2, p.tn));
  if (p.fin) {
    const colour: Rgb = [0.55, 0.5, 0.25];
    const ocellus = disc(tn, yn, 0.68, 0.17, 0.045);
    const halo = disc(tn, yn, 0.68, 0.17, 0.065);
    return mix(mix(colour, [0.95, 0.85, 0.2], halo * 0.9), dark, ocellus);
  }
  let colour = mix(cream, olive, smoothstep(0.35, 0.8, p.h));
  const freckle = noise(Math.floor(p.tn * 300), Math.floor(p.h * 100));
  colour = mix(colour, dark, smoothstep(0.88, 1, freckle) * 0.6 * smoothstep(0.3, 0.7, p.h));
  const eye = ring(tn, yn, 0.12, 0.08, 0.07, 0.018);
  const flank = ring(tn, yn, 0.5, 0.05, 0.12, 0.022) * smoothstep(0.2, 0.5, p.h);
  const stripes =
    Math.max(
      band(p.tn - (p.h - 0.5) * 0.1, 0.3, 0.01, 0.006),
      band(p.tn - (p.h - 0.5) * 0.1, 0.78, 0.012, 0.006),
    ) * smoothstep(0.45, 0.8, p.h);
  colour = mix(colour, dark, Math.max(eye, flank, stripes) * 0.85);
  const iris = eyeSpot(tn, yn, 0.12, 0.08, 0.028, [0.75, 0.55, 0.15]);
  return iris ?? colour;
}

export const FRESHWATER_PUFFER_RECIPES: LoftFishRecipe[] = [
  {
    id: 'figure-8-puffer',
    species: 'figure-8-puffer',
    fallbackLengthM: 0.055,
    roughness: 0.4,
    note: 'Tetraodon biocellatus: no model and no allowed photo, so the body is a procedural loft and the colour map is painted from the species description alone',
    texture: {
      kind: 'synthetic',
      ...canvasFor(PUFFER_SECTIONS, 0.32, -0.32, 0.25),
      paint: paintFigure8Puffer,
    },
    spec: {
      roundness: 2.1,
      membrane: true,
      sections: PUFFER_SECTIONS,
      fins: [
        {
          fin: 'dorsal',
          from: 0.6,
          to: 0.76,
          anchor: 'top',
          shape: [0.06, 0.12, 0.13, 0.07],
          sweep: 0.3,
        },
        {
          fin: 'anal',
          from: 0.62,
          to: 0.76,
          anchor: 'bottom',
          shape: [0.05, 0.1, 0.1, 0.05],
          sweep: 0.3,
        },
        {
          fin: 'pectoral',
          from: 0.2,
          to: 0.26,
          anchor: 'side',
          flankHeight: 0.4,
          direction: [0.85, -0.1],
          shape: [0.04, 0.1, 0.08],
          sweep: 0.5,
        },
      ],
      caudal: { shape: [0.14, 0.19, 0.21, 0.19, 0.14], spread: 0.02 },
    },
  },
];
