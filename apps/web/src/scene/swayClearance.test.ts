/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import type { DecorItem } from '@aquarium/shared';
import catalog from '../../public/assets/index.json';
import { sampleCurrent } from './current';
import { LEAN_SECONDS, generateEuphyllia, parseEuphylliaId } from './euphyllia';
import { decorMatrix } from './hardscape';
import { loadPreset } from './preset';
import { DEFAULT_CURRENT } from './TankScene';

interface MeshoptExtension {
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride: number;
  readonly count: number;
  readonly mode: string;
  readonly filter?: string;
}

interface GlbBufferView {
  readonly extensions?: { readonly EXT_meshopt_compression?: MeshoptExtension };
}

interface GlbJson {
  readonly accessors: readonly { readonly bufferView: number }[];
  readonly bufferViews: readonly GlbBufferView[];
  readonly meshes: readonly {
    readonly primitives: readonly {
      readonly attributes: { readonly POSITION: number };
      readonly indices: number;
    }[];
  }[];
}

interface Soup {
  readonly positions: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
}

function decodeView(view: GlbBufferView | undefined, bin: Uint8Array): Uint8Array {
  const ext = view?.extensions?.EXT_meshopt_compression;
  if (!ext) throw new Error('rock glb is expected to be meshopt-compressed');
  const start = ext.byteOffset ?? 0;
  const target = new Uint8Array(ext.count * ext.byteStride);
  MeshoptDecoder.decodeGltfBuffer(
    target,
    ext.count,
    ext.byteStride,
    bin.subarray(start, start + ext.byteLength),
    ext.mode,
    ext.filter ?? 'NONE',
  );
  return target;
}

async function readRock(file: string): Promise<Soup> {
  await MeshoptDecoder.ready;
  const data = readFileSync(fileURLToPath(new URL(`../../public/assets/${file}`, import.meta.url)));
  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8')) as GlbJson;
  const binStart = 20 + jsonLength + 8;
  const bin = new Uint8Array(data.buffer, data.byteOffset + binStart, data.length - binStart);
  const prim = json.meshes[0]?.primitives[0];
  if (!prim) throw new Error(`${file} has no primitive`);
  const pos = decodeView(
    json.bufferViews[json.accessors[prim.attributes.POSITION]?.bufferView ?? -1],
    bin,
  );
  const idxView = json.bufferViews[json.accessors[prim.indices]?.bufferView ?? -1];
  const idx = decodeView(idxView, bin);
  const stride = idxView?.extensions?.EXT_meshopt_compression?.byteStride ?? 2;
  return {
    positions: new Float32Array(pos.buffer, pos.byteOffset, pos.byteLength / 4),
    indices:
      stride === 2
        ? new Uint16Array(idx.buffer, idx.byteOffset, idx.byteLength / 2)
        : new Uint32Array(idx.buffer, idx.byteOffset, idx.byteLength / 4),
  };
}

interface WorldRock {
  readonly id: string;
  readonly tris: Float64Array;
  readonly min: Vector3;
  readonly max: Vector3;
}

function worldRock(soup: Soup, item: DecorItem): WorldRock {
  const matrix = decorMatrix(item);
  const v = new Vector3();
  const world = new Float64Array(soup.positions.length);
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < soup.positions.length; i += 3) {
    v.set(soup.positions[i] ?? 0, soup.positions[i + 1] ?? 0, soup.positions[i + 2] ?? 0);
    v.applyMatrix4(matrix);
    world.set([v.x, v.y, v.z], i);
    min.min(v);
    max.max(v);
  }
  const tris = new Float64Array(soup.indices.length * 3);
  soup.indices.forEach((vertex, i) => {
    tris.set(world.subarray(vertex * 3, vertex * 3 + 3), i * 3);
  });
  return { id: item.assetId, tris, min, max };
}

/** Parity of triangle crossings along a +Y ray; the rock meshes are closed. */
function inside(rock: WorldRock, x: number, y: number, z: number): boolean {
  if (
    x < rock.min.x ||
    x > rock.max.x ||
    y < rock.min.y ||
    y > rock.max.y ||
    z < rock.min.z ||
    z > rock.max.z
  ) {
    return false;
  }
  const t = rock.tris;
  let crossings = 0;
  for (let i = 0; i < t.length; i += 9) {
    const ax = (t[i] ?? 0) - x;
    const az = (t[i + 2] ?? 0) - z;
    const bx = (t[i + 3] ?? 0) - x;
    const bz = (t[i + 5] ?? 0) - z;
    const cx = (t[i + 6] ?? 0) - x;
    const cz = (t[i + 8] ?? 0) - z;
    const d1 = ax * bz - az * bx;
    const d2 = bx * cz - bz * cx;
    const d3 = cx * az - cz * ax;
    if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
    const sum = d1 + d2 + d3;
    if (sum === 0) continue;
    const hitY = ((t[i + 1] ?? 0) * d2 + (t[i + 4] ?? 0) * d3 + (t[i + 7] ?? 0) * d1) / sum;
    if (hitY > y) crossings++;
  }
  return crossings % 2 === 1;
}

describe('reef Euphyllia sway clears the rock', () => {
  const preset = loadPreset('reef');
  const current = preset.current ?? DEFAULT_CURRENT;
  const kinds = new Map(catalog.assets.map((a) => [a.id, a.kind]));

  it('keeps every swayed tentacle vertex out of every rock over the gust cycle', async () => {
    const soups = new Map<string, Soup>();
    const rocks: WorldRock[] = [];
    for (const item of preset.decor) {
      if (kinds.get(item.assetId) !== 'rock') continue;
      let soup = soups.get(item.assetId);
      if (!soup) {
        soup = await readRock(`rock/${item.assetId}/lod1.glb`);
        soups.set(item.assetId, soup);
      }
      rocks.push(worldRock(soup, item));
    }
    expect(rocks.length).toBeGreaterThanOrEqual(5);

    const clipped: string[] = [];
    const flow: number[] = [0, 0, 0];
    const period = 3 * current.gustPeriodS;
    const p = new Vector3();
    const at = new Vector3();
    for (const item of preset.decor) {
      const procedural = parseEuphylliaId(item.assetId);
      if (!procedural) continue;
      const mesh = generateEuphyllia(procedural.variant, procedural.seed, 2);
      const matrix = decorMatrix(item);
      const origin = new Vector3(...item.position);
      for (const rock of rocks) {
        let worst = 0;
        for (let t = 0; t < period; t += 0.25) {
          let count = 0;
          for (let i = 0; i < mesh.sway.length; i++) {
            const sway = mesh.sway[i] ?? 0;
            p.set(
              mesh.positions[i * 3] ?? 0,
              mesh.positions[i * 3 + 1] ?? 0,
              mesh.positions[i * 3 + 2] ?? 0,
            );
            at.copy(p).applyMatrix4(matrix);
            if (sway > 0) {
              const sample = p.clone().multiplyScalar(item.scale).add(origin);
              sampleCurrent(current, sample.x, sample.y, sample.z, t, flow);
              const lean = sway * sway * LEAN_SECONDS;
              at.x += (flow[0] ?? 0) * lean;
              at.z += (flow[2] ?? 0) * lean;
            }
            if (inside(rock, at.x, at.y, at.z)) count++;
          }
          worst = Math.max(worst, count);
        }
        if (worst > 0) clipped.push(`${item.assetId} into ${rock.id}: ${worst} vertices`);
      }
    }
    expect(clipped).toEqual([]);
  }, 120_000);
});
