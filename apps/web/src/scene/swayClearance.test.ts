/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Matrix4, Triangle, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import type { DecorItem } from '@aquarium/shared';
import catalog from '../../public/assets/index.json';
import { WAVES_PER_WRAP } from './anemone';
import { sampleCurrent, wrapPeriodS, type CurrentParameters } from './current';
import { LEAN_SECONDS, WAVE_METRES, generateEuphyllia, parseEuphylliaId } from './euphyllia';
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
  readonly indices: Uint32Array;
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

async function readMesh(file: string): Promise<Soup> {
  await MeshoptDecoder.ready;
  const data = readFileSync(fileURLToPath(new URL(`../../public/assets/${file}`, import.meta.url)));
  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8')) as GlbJson;
  const binStart = 20 + jsonLength + 8;
  const bin = new Uint8Array(data.buffer, data.byteOffset + binStart, data.length - binStart);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const prim of json.meshes[0]?.primitives ?? []) {
    const pos = decodeView(
      json.bufferViews[json.accessors[prim.attributes.POSITION]?.bufferView ?? -1],
      bin,
    );
    const idxView = json.bufferViews[json.accessors[prim.indices]?.bufferView ?? -1];
    const idx = decodeView(idxView, bin);
    const stride = idxView?.extensions?.EXT_meshopt_compression?.byteStride ?? 2;
    const base = positions.length / 3;
    positions.push(...new Float32Array(pos.buffer, pos.byteOffset, pos.byteLength / 4));
    const view =
      stride === 2
        ? new Uint16Array(idx.buffer, idx.byteOffset, idx.byteLength / 2)
        : new Uint32Array(idx.buffer, idx.byteOffset, idx.byteLength / 4);
    for (const i of view) indices.push(base + i);
  }
  if (indices.length === 0) throw new Error(`${file} has no primitive`);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

interface WorldRock {
  readonly id: string;
  readonly solid: boolean;
  readonly tris: Float64Array;
  readonly min: Vector3;
  readonly max: Vector3;
}

function worldRock(soup: Soup, item: DecorItem, solid: boolean): WorldRock {
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
  return { id: item.assetId, solid, tris, min, max };
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

const CONTACT_METRES = 0.0005;
const triangle = new Triangle();
const closest = new Vector3();

/** Open coral meshes have no inside, so a vertex counts as clipping when it touches the surface. */
function touches(rock: WorldRock, p: Vector3): boolean {
  const m = CONTACT_METRES;
  if (
    p.x < rock.min.x - m ||
    p.x > rock.max.x + m ||
    p.y < rock.min.y - m ||
    p.y > rock.max.y + m ||
    p.z < rock.min.z - m ||
    p.z > rock.max.z + m
  ) {
    return false;
  }
  const t = rock.tris;
  for (let i = 0; i < t.length; i += 9) {
    triangle.a.set(t[i] ?? 0, t[i + 1] ?? 0, t[i + 2] ?? 0);
    triangle.b.set(t[i + 3] ?? 0, t[i + 4] ?? 0, t[i + 5] ?? 0);
    triangle.c.set(t[i + 6] ?? 0, t[i + 7] ?? 0, t[i + 8] ?? 0);
    triangle.closestPointToPoint(p, closest);
    if (closest.distanceToSquared(p) < m * m) return true;
  }
  return false;
}

/** Where a colony vertex sits at time `t`: the shader's lean along the shared current plus its small wave. */
function swayedPosition(
  out: Vector3,
  local: Vector3,
  sway: number,
  item: DecorItem,
  matrix: Matrix4,
  current: CurrentParameters,
  t: number,
  flow: number[],
): void {
  const omega = (2 * Math.PI * WAVES_PER_WRAP) / wrapPeriodS(current);
  const angle = t * omega + local.x * 23 + local.z * 17;
  const waved = new Vector3(Math.sin(angle), Math.sin(angle * 2 + 1.7) * 0.4, Math.sin(angle + 1.9))
    .multiplyScalar(sway * WAVE_METRES)
    .add(local);
  out.copy(waved).applyMatrix4(matrix);
  if (sway === 0) return;
  const sample = local
    .clone()
    .multiplyScalar(item.scale)
    .add(new Vector3(...item.position));
  sampleCurrent(current, sample.x, sample.y, sample.z, t, flow);
  const lean = sway * sway * LEAN_SECONDS;
  out.x += (flow[0] ?? 0) * lean;
  out.z += (flow[2] ?? 0) * lean;
}

describe('reef Euphyllia sway clears rock and coral', () => {
  const preset = loadPreset('reef');
  const current = preset.current ?? DEFAULT_CURRENT;
  const kinds = new Map(catalog.assets.map((a) => [a.id, a.kind]));

  it('keeps every swayed tentacle vertex off every rock and coral over the gust cycle', async () => {
    const meshes = new Map<string, Soup>();
    const obstacles: WorldRock[] = [];
    for (const item of preset.decor) {
      const kind = kinds.get(item.assetId);
      if (kind !== 'rock' && kind !== 'coral') continue;
      let soup = meshes.get(item.assetId);
      if (!soup) {
        soup = await readMesh(`${kind}/${item.assetId}/lod1.glb`);
        meshes.set(item.assetId, soup);
      }
      obstacles.push(worldRock(soup, item, kind === 'rock'));
    }
    expect(obstacles.filter((o) => o.solid).length).toBeGreaterThanOrEqual(5);
    expect(obstacles.filter((o) => !o.solid).length).toBeGreaterThanOrEqual(4);

    const clipped: string[] = [];
    const flow: number[] = [0, 0, 0];
    const period = wrapPeriodS(current);
    const local = new Vector3();
    const at = new Vector3();
    for (const item of preset.decor) {
      const procedural = parseEuphylliaId(item.assetId);
      if (!procedural) continue;
      const mesh = generateEuphyllia(procedural.variant, procedural.seed, 2);
      const matrix = decorMatrix(item);
      for (const obstacle of obstacles) {
        let worst = 0;
        for (let t = 0; t < period; t += 0.25) {
          let count = 0;
          for (let i = 0; i < mesh.sway.length; i++) {
            local.set(
              mesh.positions[i * 3] ?? 0,
              mesh.positions[i * 3 + 1] ?? 0,
              mesh.positions[i * 3 + 2] ?? 0,
            );
            swayedPosition(at, local, mesh.sway[i] ?? 0, item, matrix, current, t, flow);
            const hit = obstacle.solid ? inside(obstacle, at.x, at.y, at.z) : touches(obstacle, at);
            if (hit) count++;
          }
          worst = Math.max(worst, count);
        }
        if (worst > 0) clipped.push(`${item.assetId} into ${obstacle.id}: ${worst} vertices`);
      }
    }
    expect(clipped).toEqual([]);
  }, 300_000);
});
