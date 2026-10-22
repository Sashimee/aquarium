import { FIN_ID_ATTRIBUTE, FIN_IDS, FIN_MASK_ATTRIBUTE } from './index-schema.ts';
import { mix, smooth } from './loft-fish.ts';
import type { MaterialDef, Part } from './parts.ts';

type Rgb = [number, number, number];

/** tn runs snout 0 to the end of the peduncle 1 (the caudal lies beyond), h runs belly 0 to back 1 over the rigid body; fin is the fin id covering the texel, 0 for body. */
export type ScanPainter = (tn: number, h: number, fin: number) => Rgb;

export interface ScanPaintSpec {
  paint: ScanPainter;
  width: number;
  height: number;
  roughness: number;
}

interface Frame {
  snoutZ: number;
  tailZ: number;
  bottomY: number;
  topY: number;
  bodyBottomY: number;
  bodySnoutZ: number;
  bodyLength: number;
  bodyHeight: number;
}

function bounds(parts: Part[], include: (part: Part, vertex: number) => boolean) {
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const part of parts)
    for (let i = 0; i < part.positions.length / 3; i++) {
      if (!include(part, i)) continue;
      const y = part.positions[i * 3 + 1]!;
      const z = part.positions[i * 3 + 2]!;
      lo[0] = Math.min(lo[0]!, y);
      hi[0] = Math.max(hi[0]!, y);
      lo[1] = Math.min(lo[1]!, z);
      hi[1] = Math.max(hi[1]!, z);
    }
  return { lo: lo as [number, number], hi: hi as [number, number] };
}

export function sideProjection(parts: Part[]): Frame {
  for (const part of parts)
    if (!part.extra[FIN_ID_ATTRIBUTE] || !part.extra[FIN_MASK_ATTRIBUTE])
      throw new Error('scan paint needs the fin id and fin mask baked before it projects UVs');
  const all = bounds(parts, () => true);
  const rigid = bounds(parts, (part, i) => part.extra[FIN_ID_ATTRIBUTE]![i] === 0);
  if (!Number.isFinite(rigid.lo[0]) || rigid.hi[1] <= rigid.lo[1])
    throw new Error('scan paint found no rigid body vertices to frame the texture on');
  return {
    snoutZ: all.hi[1],
    tailZ: all.lo[1],
    bottomY: all.lo[0],
    topY: all.hi[0],
    bodyBottomY: rigid.lo[0],
    bodySnoutZ: rigid.hi[1],
    bodyLength: rigid.hi[1] - rigid.lo[1],
    bodyHeight: rigid.hi[0] - rigid.lo[0],
  };
}

export function projectSideUv(parts: Part[], frame: Frame): void {
  const length = frame.snoutZ - frame.tailZ;
  const height = frame.topY - frame.bottomY;
  for (const part of parts) {
    for (let i = 0; i < part.positions.length / 3; i++) {
      part.uvs[i * 2] = (frame.snoutZ - part.positions[i * 3 + 2]!) / length;
      part.uvs[i * 2 + 1] = (frame.topY - part.positions[i * 3 + 1]!) / height;
    }
  }
}

function triangleFin(part: Part, a: number, b: number, c: number): number {
  const id = part.extra[FIN_ID_ATTRIBUTE]!;
  const ids = [id[a]!, id[b]!, id[c]!];
  for (const candidate of ids)
    if (candidate !== 0 && ids.filter((other) => other === candidate).length >= 2) return candidate;
  return 0;
}

function fillTriangle(
  layer: Int8Array,
  width: number,
  height: number,
  corners: [number, number][],
  value: number,
): void {
  const [p0, p1, p2] = corners as [[number, number], [number, number], [number, number]];
  const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  if (Math.abs(area) < 1e-9) return;
  const slack = -0.5 / Math.sqrt(Math.abs(area));
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((p1[0] - px) * (p2[1] - py) - (p2[0] - px) * (p1[1] - py)) / area;
      const w1 = ((p2[0] - px) * (p0[1] - py) - (p0[0] - px) * (p2[1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= slack && w1 >= slack && w2 >= slack) layer[y * width + x] = value + 1;
    }
}

/** Per texel: -1 outside every triangle, otherwise the fin id of the triangle covering it. Fins are drawn over the body. */
export function rasteriseFinLayer(parts: Part[], width: number, height: number): Int8Array {
  const layer = new Int8Array(width * height);
  const passes: boolean[] = [false, true];
  for (const finPass of passes)
    for (const part of parts)
      for (let t = 0; t < part.indices.length; t += 3) {
        const a = part.indices[t]!;
        const b = part.indices[t + 1]!;
        const c = part.indices[t + 2]!;
        const fin = triangleFin(part, a, b, c);
        if ((fin !== 0) !== finPass) continue;
        const corners = [a, b, c].map((v): [number, number] => [
          part.uvs[v * 2]! * width,
          part.uvs[v * 2 + 1]! * height,
        ]);
        fillTriangle(layer, width, height, corners, fin);
      }
  for (let i = 0; i < layer.length; i++) layer[i] = layer[i]! - 1;
  return layer;
}

export function dilateLayer(
  layer: Int8Array,
  width: number,
  height: number,
  rounds: number,
): Int8Array {
  let current = layer;
  for (let round = 0; round < rounds; round++) {
    const next = Int8Array.from(current);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (current[y * width + x]! >= 0) continue;
        const neighbours = [
          x > 0 ? current[y * width + x - 1]! : -1,
          x < width - 1 ? current[y * width + x + 1]! : -1,
          y > 0 ? current[(y - 1) * width + x]! : -1,
          y < height - 1 ? current[(y + 1) * width + x]! : -1,
        ];
        const found = neighbours.find((value) => value >= 0);
        if (found !== undefined) next[y * width + x] = found;
      }
    current = next;
  }
  return current;
}

const BLEED_ROUNDS = 12;

export function paintScanTexture(
  parts: Part[],
  baseMaterial: MaterialDef,
  spec: ScanPaintSpec,
): MaterialDef {
  const frame = sideProjection(parts);
  projectSideUv(parts, frame);
  for (const part of parts) part.material = baseMaterial.name;
  const { width, height } = spec;
  const layer = dilateLayer(rasteriseFinLayer(parts, width, height), width, height, BLEED_ROUNDS);
  const length = frame.snoutZ - frame.tailZ;
  const totalHeight = frame.topY - frame.bottomY;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const z = frame.snoutZ - ((x + 0.5) / width) * length;
      const worldY = frame.topY - ((y + 0.5) / height) * totalHeight;
      const tn = (frame.bodySnoutZ - z) / frame.bodyLength;
      const h = (worldY - frame.bodyBottomY) / frame.bodyHeight;
      const fin = Math.max(0, layer[y * width + x]!);
      const [r, g, b] = spec.paint(tn, h, fin);
      const o = (y * width + x) * 4;
      data[o] = Math.round(Math.min(1, Math.max(0, r)) * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
      data[o + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
      data[o + 3] = 255;
    }
  return {
    ...baseMaterial,
    baseColorFactor: [1, 1, 1, 1],
    baseColor: { role: 'baseColor', codec: 'etc1s', image: { width, height, data } },
    roughness: spec.roughness,
    metallic: 0,
  };
}

function ellipse(tn: number, h: number, cx: number, cy: number, rx: number, ry: number): number {
  return Math.hypot((tn - cx) / rx, (h - cy) / ry);
}

const FIN_COLOUR: Record<number, Rgb> = {
  [FIN_IDS.caudal]: [0.62, 0.34, 0.3],
  [FIN_IDS.dorsal]: [0.09, 0.09, 0.1],
  [FIN_IDS.anal]: [0.42, 0.22, 0.22],
  [FIN_IDS.pectoral]: [0.66, 0.5, 0.45],
  [FIN_IDS.pelvic]: [0.7, 0.3, 0.26],
};

/** Hyphessobrycon megalopterus painted from its known pattern: silver-grey body, black humeral blotch behind a pale bar, black dorsal, reddish pelvic and anal fins. */
export function paintBlackPhantom(tn: number, h: number, fin: number): Rgb {
  const finColour = FIN_COLOUR[fin];
  if (finColour) return finColour;
  const silver: Rgb = [0.66, 0.66, 0.62];
  const belly: Rgb = [0.84, 0.8, 0.74];
  const back: Rgb = [0.3, 0.3, 0.27];
  let colour = mix(belly, silver, smooth(0.12, 0.45, h));
  colour = mix(colour, back, smooth(0.62, 0.9, h));
  colour = mix(colour, [0.52, 0.56, 0.6], 0.35 * (1 - smooth(0.3, 0.6, Math.abs(h - 0.5))));

  const pale = 1 - smooth(0.02, 0.05, Math.abs(tn - 0.2));
  colour = mix(
    colour,
    [0.9, 0.9, 0.86],
    0.7 * pale * smooth(0.15, 0.3, h) * (1 - smooth(0.78, 0.92, h)),
  );

  const blotch = ellipse(tn, h, 0.3, 0.58, 0.055, 0.23);
  colour = mix(colour, [0.015, 0.015, 0.02], 1 - smooth(0.7, 1, blotch));

  const eye = Math.hypot(tn - 0.085, (h - 0.6) * 0.45);
  if (eye < 0.04) colour = mix([0.82, 0.74, 0.5], [0.95, 0.95, 0.9], smooth(0.025, 0.04, eye));
  if (eye < 0.022) colour = [0.02, 0.02, 0.03];

  const peduncle = smooth(0.82, 1, tn);
  return mix(colour, [0.35, 0.3, 0.28], 0.35 * peduncle);
}
