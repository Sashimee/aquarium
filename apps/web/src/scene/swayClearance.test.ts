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
  readonly accessors: readonly {
    readonly bufferView: number;
    readonly byteOffset?: number;
    readonly count: number;
    readonly componentType: number;
  }[];
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

const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

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
    const accessor = json.accessors[prim.indices];
    if (!accessor) throw new Error(`${file} primitive has no index accessor`);
    const idx = decodeView(json.bufferViews[accessor.bufferView], bin);
    const base = positions.length / 3;
    positions.push(...new Float32Array(pos.buffer, pos.byteOffset, pos.byteLength / 4));
    if (accessor.componentType !== UNSIGNED_SHORT && accessor.componentType !== UNSIGNED_INT) {
      throw new Error(`${file} index componentType ${accessor.componentType} is not 5123 or 5125`);
    }
    const wide = accessor.componentType === UNSIGNED_INT;
    const offset = idx.byteOffset + (accessor.byteOffset ?? 0);
    if ((accessor.byteOffset ?? 0) + accessor.count * (wide ? 4 : 2) > idx.byteLength) {
      throw new Error(`${file} index accessor overruns its buffer view`);
    }
    const view = wide
      ? new Uint32Array(idx.buffer, offset, accessor.count)
      : new Uint16Array(idx.buffer, offset, accessor.count);
    for (const i of view) indices.push(base + i);
  }
  if (indices.length === 0) throw new Error(`${file} has no primitive`);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

interface WorldRock {
  readonly id: string;
  readonly solid: boolean;
  readonly closed: boolean;
  readonly tris: Float64Array;
  readonly min: Vector3;
  readonly max: Vector3;
}

function worldRock(soup: Soup, item: DecorItem, solid: boolean, closed: boolean): WorldRock {
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
  return { id: item.assetId, solid, closed, tris, min, max };
}

/** Parity of triangle crossings along a +Y ray; the rock meshes are closed. */
function inside(rock: WorldRock, t: Float64Array, x: number, y: number, z: number): boolean {
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
const TIME_STEP_S = 0.1;
const EPSILON = 1e-12;

function crossesTriangle(t: Float64Array, i: number, p: Vector3, q: Vector3): boolean {
  const ax = t[i] ?? 0;
  const ay = t[i + 1] ?? 0;
  const az = t[i + 2] ?? 0;
  const e1x = (t[i + 3] ?? 0) - ax;
  const e1y = (t[i + 4] ?? 0) - ay;
  const e1z = (t[i + 5] ?? 0) - az;
  const e2x = (t[i + 6] ?? 0) - ax;
  const e2y = (t[i + 7] ?? 0) - ay;
  const e2z = (t[i + 8] ?? 0) - az;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dz = q.z - p.z;
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < EPSILON) return false;
  const inv = 1 / det;
  const sx = p.x - ax;
  const sy = p.y - ay;
  const sz = p.z - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return s >= 0 && s <= 1;
}

function uniqueEdges(indices: Uint32Array): Uint32Array {
  const seen = new Set<number>();
  const edges: number[] = [];
  const stride = indices.reduce((m, i) => Math.max(m, i), 0) + 1;
  for (let i = 0; i < indices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[i + k] ?? 0;
      const b = indices[i + ((k + 1) % 3)] ?? 0;
      const key = Math.min(a, b) * stride + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(a, b);
    }
  }
  return Uint32Array.from(edges);
}

const GRID_CELL_METRES = 0.01;

class TriangleGrid {
  private readonly cells = new Map<number, number[]>();

  constructor(private readonly tris: Float64Array) {
    for (let i = 0; i < tris.length; i += 9) {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 9; k++) {
        const axis = k % 3;
        lo[axis] = Math.min(lo[axis] ?? 0, tris[i + k] ?? 0);
        hi[axis] = Math.max(hi[axis] ?? 0, tris[i + k] ?? 0);
      }
      this.visit(lo, hi, (cell) => {
        const list = this.cells.get(cell);
        if (list) list.push(i);
        else this.cells.set(cell, [i]);
      });
    }
  }

  private visit(lo: number[], hi: number[], fn: (cell: number) => void): void {
    const c = (v: number | undefined) => Math.floor((v ?? 0) / GRID_CELL_METRES);
    for (let x = c(lo[0]); x <= c(hi[0]); x++) {
      for (let y = c(lo[1]); y <= c(hi[1]); y++) {
        for (let z = c(lo[2]); z <= c(hi[2]); z++) fn((x * 4096 + y) * 4096 + z);
      }
    }
  }

  segmentCrosses(p: Vector3, q: Vector3): boolean {
    const lo = [Math.min(p.x, q.x), Math.min(p.y, q.y), Math.min(p.z, q.z)];
    const hi = [Math.max(p.x, q.x), Math.max(p.y, q.y), Math.max(p.z, q.z)];
    let hit = false;
    this.visit(lo, hi, (cell) => {
      if (hit) return;
      for (const i of this.cells.get(cell) ?? []) {
        if (crossesTriangle(this.tris, i, p, q)) {
          hit = true;
          return;
        }
      }
    });
    return hit;
  }
}

function trianglesWithin(
  rock: WorldRock,
  min: Vector3,
  max: Vector3,
  margin: number,
  openUp = false,
): Float64Array {
  const t = rock.tris;
  const lo = [min.x - margin, min.y - margin, min.z - margin];
  const hi = [max.x + margin, openUp ? Infinity : max.y + margin, max.z + margin];
  const kept: number[] = [];
  for (let i = 0; i < t.length; i += 9) {
    let outside = false;
    for (let axis = 0; axis < 3 && !outside; axis++) {
      const a = t[i + axis] ?? 0;
      const b = t[i + 3 + axis] ?? 0;
      const c = t[i + 6 + axis] ?? 0;
      outside = Math.max(a, b, c) < (lo[axis] ?? 0) || Math.min(a, b, c) > (hi[axis] ?? 0);
    }
    if (!outside) for (let k = 0; k < 9; k++) kept.push(t[i + k] ?? 0);
  }
  return Float64Array.from(kept);
}
const closest = new Vector3();

/** Open coral meshes have no inside, so a vertex counts as clipping when it touches the surface. */
function touches(rock: WorldRock, tris: Float64Array, p: Vector3): boolean {
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
  const t = tris;
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

function clippingReport(
  decor: readonly DecorItem[],
  obstacles: readonly WorldRock[],
  current: CurrentParameters,
  stepS = TIME_STEP_S,
): string[] {
  const clipped: string[] = [];
  const flow: number[] = [0, 0, 0];
  const period = wrapPeriodS(current);
  const local = new Vector3();
  const p = new Vector3();
  const q = new Vector3();
  for (const item of decor) {
    const procedural = parseEuphylliaId(item.assetId);
    if (!procedural) continue;
    const mesh = generateEuphyllia(procedural.variant, procedural.seed, 2);
    const matrix = decorMatrix(item);
    const edges = uniqueEdges(mesh.indices);
    const vertexCount = mesh.sway.length;
    const frames: Float64Array[] = [];
    const lo = new Vector3(Infinity, Infinity, Infinity);
    const hi = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let t = 0; t < period; t += stepS) {
      const frame = new Float64Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        local.set(
          mesh.positions[i * 3] ?? 0,
          mesh.positions[i * 3 + 1] ?? 0,
          mesh.positions[i * 3 + 2] ?? 0,
        );
        swayedPosition(p, local, mesh.sway[i] ?? 0, item, matrix, current, t, flow);
        frame.set([p.x, p.y, p.z], i * 3);
        lo.min(p);
        hi.max(p);
      }
      frames.push(frame);
    }
    for (const obstacle of obstacles) {
      const near = trianglesWithin(obstacle, lo, hi, CONTACT_METRES);
      if (near.length === 0) continue;
      const column = obstacle.closed
        ? trianglesWithin(obstacle, lo, hi, CONTACT_METRES, true)
        : near;
      const grid = new TriangleGrid(near);
      let worstVertices = 0;
      let worstEdges = 0;
      for (const frame of frames) {
        let vertices = 0;
        for (let i = 0; i < vertexCount; i++) {
          p.set(frame[i * 3] ?? 0, frame[i * 3 + 1] ?? 0, frame[i * 3 + 2] ?? 0);
          const hit = obstacle.closed
            ? inside(obstacle, column, p.x, p.y, p.z)
            : touches(obstacle, near, p);
          if (hit) vertices++;
        }
        let crossed = 0;
        for (let e = 0; e < edges.length; e += 2) {
          const a = (edges[e] ?? 0) * 3;
          const b = (edges[e + 1] ?? 0) * 3;
          p.set(frame[a] ?? 0, frame[a + 1] ?? 0, frame[a + 2] ?? 0);
          q.set(frame[b] ?? 0, frame[b + 1] ?? 0, frame[b + 2] ?? 0);
          if (grid.segmentCrosses(p, q)) crossed++;
        }
        worstVertices = Math.max(worstVertices, vertices);
        worstEdges = Math.max(worstEdges, crossed);
      }
      if (worstVertices > 0 || worstEdges > 0) {
        clipped.push(
          `${item.assetId} into ${obstacle.id}: ${worstVertices} vertices, ${worstEdges} edges`,
        );
      }
    }
  }
  return clipped;
}

async function loadObstacles(decor: readonly DecorItem[]): Promise<WorldRock[]> {
  const kinds = new Map(catalog.assets.map((a) => [a.id, a.kind]));
  const meshes = new Map<string, Soup>();
  const obstacles: WorldRock[] = [];
  for (const item of decor) {
    const kind = kinds.get(item.assetId);
    if (kind !== 'rock' && kind !== 'coral') continue;
    let soup = meshes.get(item.assetId);
    if (!soup) {
      soup = await readMesh(`${kind}/${item.assetId}/lod1.glb`);
      meshes.set(item.assetId, soup);
    }
    obstacles.push(
      worldRock(soup, item, kind === 'rock', kind === 'rock' || item.assetId === 'brain-coral'),
    );
  }
  return obstacles;
}

describe('readMesh', () => {
  it('reads each primitive from its own index slice', async () => {
    const soup = await readMesh('coral/acropora-cytherea/lod1.glb');
    expect(soup.indices.length).toBe(20943 + 5283);
    const vertices = soup.positions.length / 3;
    expect(vertices).toBe(6550 + 2105);
    expect(Math.max(...soup.indices)).toBe(vertices - 1);
    expect(Math.max(...soup.indices.subarray(0, 20943))).toBe(6549);
    expect(Math.min(...soup.indices.subarray(20943))).toBe(6550);
  });
});

describe('crossesTriangle', () => {
  const tri = Float64Array.from([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]);

  it('detects a segment passing through a thin triangle that no vertex touches', () => {
    expect(
      crossesTriangle(tri, 0, new Vector3(0.002, 0.002, -0.01), new Vector3(0.002, 0.002, 0.01)),
    ).toBe(true);
  });

  it('rejects segments that stop short, pass beside, or run parallel', () => {
    expect(
      crossesTriangle(tri, 0, new Vector3(0.002, 0.002, -0.01), new Vector3(0.002, 0.002, -0.001)),
    ).toBe(false);
    expect(
      crossesTriangle(tri, 0, new Vector3(0.02, 0.02, -0.01), new Vector3(0.02, 0.02, 0.01)),
    ).toBe(false);
    expect(crossesTriangle(tri, 0, new Vector3(0, 0, 0.01), new Vector3(0.01, 0, 0.01))).toBe(
      false,
    );
  });
});

describe('reef Euphyllia sway clears rock and coral', () => {
  const preset = loadPreset('reef');
  const current = preset.current ?? DEFAULT_CURRENT;

  it('keeps every swayed tentacle edge and vertex off every rock and coral over the gust cycle', async () => {
    const obstacles = await loadObstacles(preset.decor);
    expect(obstacles.filter((o) => o.solid).length).toBeGreaterThanOrEqual(5);
    expect(obstacles.filter((o) => !o.solid).length).toBeGreaterThanOrEqual(4);
    expect(clippingReport(preset.decor, obstacles, current)).toEqual([]);
  }, 300_000);

  it('reports a colony moved into a brain coral dome', async () => {
    const dome = preset.decor.find((d) => d.assetId === 'brain-coral');
    const hammer = preset.decor.find((d) => parseEuphylliaId(d.assetId)?.variant === 'hammer');
    if (!dome || !hammer) throw new Error('reef preset needs a brain coral and a hammer colony');
    const moved = {
      ...hammer,
      position: [
        dome.position[0],
        dome.position[1] + 0.02,
        dome.position[2],
      ] as DecorItem['position'],
    };
    const obstacles = await loadObstacles(preset.decor);
    const report = clippingReport([moved], obstacles, current, 6);
    expect(
      report.some((line) => /into brain-coral: [1-9]\d* vertices, [1-9]\d* edges/.test(line)),
    ).toBe(true);
  }, 300_000);

  it('reports edges slicing a thin palmata blade without any vertex touching it', async () => {
    const blade = preset.decor.find((d) => d.assetId === 'acropora-palmata');
    const torch = preset.decor.find((d) => parseEuphylliaId(d.assetId)?.variant === 'torch');
    if (!blade || !torch)
      throw new Error('reef preset needs an acropora-palmata and a torch colony');
    const moved = {
      ...torch,
      position: [
        blade.position[0],
        blade.position[1] + 0.03,
        blade.position[2] + 0.1,
      ] as DecorItem['position'],
    };
    const obstacles = (await loadObstacles(preset.decor)).filter(
      (o) => o.id === 'acropora-palmata',
    );
    const report = clippingReport([moved], obstacles, current, 6);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatch(/into acropora-palmata: 0 vertices, [1-9]\d* edges/);
  }, 300_000);
});
