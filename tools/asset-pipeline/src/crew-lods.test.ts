import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { boundsOf, canonicalVertices, connectedComponents } from './crew-scan.ts';
import { uvStretchShare } from './rebake.ts';

const ASSETS = fileURLToPath(new URL('../../../apps/web/public/assets', import.meta.url));

interface ShippedPrimitive {
  material: string;
  positions: Float32Array<ArrayBuffer>;
  uvs: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
}

async function readLod(dir: string, level: number): Promise<ShippedPrimitive[]> {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(join(ASSETS, dir, `lod${level}.glb`));
  const out: ShippedPrimitive[] = [];
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives())
      out.push({
        material: prim.getMaterial()!.getName(),
        positions: Float32Array.from(prim.getAttribute('POSITION')!.getArray()!),
        uvs: Float32Array.from(prim.getAttribute('TEXCOORD_0')!.getArray()!),
        indices: Uint32Array.from(prim.getIndices()!.getArray()!),
      });
  return out;
}

type ViewAxis = 'top' | 'side' | 'front';
const VIEW_AXES: Record<ViewAxis, { across: [number, number]; toward: number }> = {
  top: { across: [0, 2], toward: 1 },
  side: { across: [2, 1], toward: 0 },
  front: { across: [0, 1], toward: 2 },
};

interface Coverage {
  size: number;
  silhouette: Uint8Array;
  facing: Uint8Array;
}

function coverageOf(prims: ShippedPrimitive[], view: ViewAxis, size = 1100): Coverage {
  const { across, toward } = VIEW_AXES[view];
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const prim of prims)
    for (let v = 0; v < prim.positions.length / 3; v++)
      across.forEach((axis, k) => {
        const value = prim.positions[v * 3 + axis]!;
        lo[k] = Math.min(lo[k]!, value);
        hi[k] = Math.max(hi[k]!, value);
      });
  const scale = (size - 32) / Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!);
  const silhouette = new Uint8Array(size * size);
  const facing = new Uint8Array(size * size);
  for (const prim of prims)
    for (let t = 0; t < prim.indices.length; t += 3) {
      const corners = [0, 1, 2].map((k) => {
        const v = prim.indices[t + k]!;
        return {
          x: (prim.positions[v * 3 + across[0]]! - lo[0]!) * scale + 16,
          y: (prim.positions[v * 3 + across[1]]! - lo[1]!) * scale + 16,
          depth: [prim.positions[v * 3]!, prim.positions[v * 3 + 1]!, prim.positions[v * 3 + 2]!],
        };
      });
      const [a, b, c] = corners as [(typeof corners)[0], (typeof corners)[0], (typeof corners)[0]];
      const e1 = a.depth.map((v, i) => b.depth[i]! - v);
      const e2 = a.depth.map((v, i) => c.depth[i]! - v);
      const normal = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      const front = normal[toward]! > 0;
      const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
      const x1 = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
      const y1 = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / area;
          const w1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          silhouette[y * size + x] = 1;
          if (front) facing[y * size + x] = 1;
        }
    }
  return { size, silhouette, facing };
}

/** Pixels where some triangle is in the silhouette but none faces the camera: the model reads as see-through there. */
function seeThroughPixels(prims: ShippedPrimitive[], view: ViewAxis): number {
  const { silhouette, facing } = coverageOf(prims, view);
  let holes = 0;
  for (let i = 0; i < silhouette.length; i++) if (silhouette[i] && !facing[i]) holes++;
  return holes;
}

function slide(mask: Uint8Array, size: number, radius: number, grow: boolean): Uint8Array {
  const run = (input: Uint8Array, horizontal: boolean): Uint8Array => {
    const out = new Uint8Array(input.length);
    for (let line = 0; line < size; line++)
      for (let at = 0; at < size; at++) {
        let all = 1;
        let any = 0;
        for (let d = -radius; d <= radius; d++) {
          const k = at + d;
          const value =
            k < 0 || k >= size ? 0 : input[horizontal ? line * size + k : k * size + line]!;
          all &&= value;
          any ||= value;
        }
        out[horizontal ? line * size + at : at * size + line] = grow ? any : all;
      }
    return out;
  };
  return run(run(mask, true), false);
}

/** Background pixels walled in by the silhouette once hairline gaps are sealed: holes bitten through the surface. */
function enclosedBackgroundPixels(prims: ShippedPrimitive[], view: ViewAxis, seal: number): number {
  const { size, silhouette } = coverageOf(prims, view);
  const sealed = slide(silhouette, size, seal, true);
  const outside = new Uint8Array(size * size);
  const queue: number[] = [];
  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = y * size + x;
    if (sealed[i] || outside[i]) return;
    outside[i] = 1;
    queue.push(i);
  };
  for (let k = 0; k < size; k++) {
    push(k, 0);
    push(k, size - 1);
    push(0, k);
    push(size - 1, k);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % size;
    const y = (i - x) / size;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  let enclosed = 0;
  for (let i = 0; i < sealed.length; i++) if (!sealed[i] && !outside[i]) enclosed++;
  return enclosed;
}

function lipGapAcrossWidth(
  prims: ShippedPrimitive[],
  length: number,
): { worst: number; samples: number } {
  const shell = prims.find((p) => p.material === 'nerite-shell')!;
  const body = prims.find((p) => p.material === 'nerite-body')!;
  const bins = 12;
  const binOf = (x: number): number => Math.floor((x / length + 0.5) * bins);
  let frontZ = -Infinity;
  for (let v = 0; v < shell.positions.length / 3; v++)
    frontZ = Math.max(frontZ, shell.positions[v * 3 + 2]!);
  const lipUnder = new Array<number>(bins).fill(Infinity);
  const lipZ = new Array<number>(bins).fill(0);
  for (let v = 0; v < shell.positions.length / 3; v++) {
    const bin = binOf(shell.positions[v * 3]!);
    const y = shell.positions[v * 3 + 1]!;
    if (bin < 0 || bin >= bins || shell.positions[v * 3 + 2]! < frontZ - 0.12 * length) continue;
    if (y < lipUnder[bin]!) {
      lipUnder[bin] = y;
      lipZ[bin] = shell.positions[v * 3 + 2]!;
    }
  }
  const bodyTop = new Array<number>(bins).fill(-Infinity);
  for (let v = 0; v < body.positions.length / 3; v++) {
    const bin = binOf(body.positions[v * 3]!);
    if (bin < 0 || bin >= bins || Math.abs(body.positions[v * 3 + 2]! - lipZ[bin]!) > 0.08 * length)
      continue;
    bodyTop[bin] = Math.max(bodyTop[bin]!, body.positions[v * 3 + 1]!);
  }
  const gaps = lipUnder.map((y, bin) => y - bodyTop[bin]!).filter(Number.isFinite);
  return { worst: Math.max(...gaps), samples: gaps.length };
}

const SCANNED = [
  { dir: 'crab/hermit-crab', material: 'hermit-crab', solid: false },
  { dir: 'snail/nerite-snail', material: 'nerite-shell', solid: true },
];

describe('nerite seating', () => {
  beforeAll(() => MeshoptDecoder.ready);

  for (const level of [0, 1, 2])
    it(`LOD${level} lip underside sits within 0.058 L of the body across the full lip width`, async () => {
      const length = 0.02;
      const gap = lipGapAcrossWidth(await readLod('snail/nerite-snail', level), length);
      expect(gap.samples).toBeGreaterThan(0);
      expect(gap.worst).toBeLessThan(0.058 * length);
    });
});

describe('shipped scan LODs', () => {
  beforeAll(() => MeshoptDecoder.ready);

  for (const { dir, material, solid } of SCANNED)
    for (const level of [0, 1, 2]) {
      it(`${dir} LOD${level} has no see-through pixels in the top and side views`, async () => {
        const prims = await readLod(dir, level);
        for (const view of ['top', 'side'] as const)
          expect(seeThroughPixels(prims, view), `${dir} LOD${level} ${view}`).toBeLessThan(8);
      });

      it.runIf(solid)(
        `${dir} LOD${level} has no holes through the surface in the top view`,
        async () => {
          const prims = await readLod(dir, level);
          expect(enclosedBackgroundPixels(prims, 'top', 2), `${dir} LOD${level}`).toBeLessThan(10);
        },
      );

      it(`${dir} LOD${level} scan mesh is one connected piece`, async () => {
        for (const prim of (await readLod(dir, level)).filter((p) => p.material === material)) {
          const { min, max } = boundsOf(prim.positions);
          const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
          const canon = canonicalVertices(prim.positions, diagonal / 4000);
          const solid: number[] = [];
          for (let t = 0; t < prim.indices.length; t += 3) {
            const [a, b, c] = [0, 1, 2].map((k) => canon[prim.indices[t + k]!]!);
            if (a !== b && b !== c && a !== c) solid.push(...prim.indices.subarray(t, t + 3));
          }
          const used = new Set(solid);
          const parts = connectedComponents(canon, solid, (v) => used.has(v)).sizes.length;
          expect(parts, `${dir} LOD${level} ${prim.material}`).toBe(1);
        }
      });

      it(`${dir} LOD${level} keeps the baked texture mapping unscrambled`, async () => {
        const prims = (await readLod(dir, level)).filter((p) => p.material === material);
        expect(prims.length).toBeGreaterThan(0);
        for (const prim of prims) expect(uvStretchShare(prim)).toBeLessThan(0.01);
      });
    }
});
