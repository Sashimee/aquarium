import { sectionEdges, type SectionKey } from './loft.ts';
import { clamp, smoothstep } from './math.ts';

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
