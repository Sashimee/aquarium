import type { Document, Primitive } from '@gltf-transform/core';
import type { Vec3 } from './math.ts';

export interface Merged {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Primitive each vertex came from, and the first vertex of each primitive. */
  primitives: Primitive[];
  firstVertex: number[];
}

export function listPrimitives(doc: Document): Primitive[] {
  return doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives());
}

export function merge(doc: Document): Merged {
  const primitives = listPrimitives(doc);
  let vertexCount = 0;
  let indexCount = 0;
  for (const prim of primitives) {
    vertexCount += prim.getAttribute('POSITION')!.getCount();
    const idx = prim.getIndices();
    indexCount += idx ? idx.getCount() : prim.getAttribute('POSITION')!.getCount();
  }
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(indexCount);
  const firstVertex: number[] = [];
  let v = 0;
  let i = 0;
  const tmp = [0, 0, 0];
  for (const prim of primitives) {
    firstVertex.push(v);
    const position = prim.getAttribute('POSITION')!;
    const uv = prim.getAttribute('TEXCOORD_0');
    const count = position.getCount();
    for (let k = 0; k < count; k++) {
      position.getElement(k, tmp);
      positions.set(tmp, (v + k) * 3);
      if (uv) {
        uv.getElement(k, tmp);
        uvs[(v + k) * 2] = tmp[0]!;
        uvs[(v + k) * 2 + 1] = tmp[1]!;
      }
    }
    const idx = prim.getIndices();
    if (idx) {
      for (let k = 0; k < idx.getCount(); k++) indices[i++] = idx.getScalar(k) + v;
    } else {
      for (let k = 0; k < count; k++) indices[i++] = v + k;
    }
    v += count;
  }
  return { positions, uvs, indices, primitives, firstVertex };
}

export function boundsOf(positions: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const value = positions[i + a]!;
      if (value < min[a]!) min[a] = value;
      if (value > max[a]!) max[a] = value;
    }
  }
  return { min, max };
}

export function triangleCount(doc: Document): number {
  let total = 0;
  for (const prim of listPrimitives(doc)) {
    const idx = prim.getIndices();
    total += (idx ? idx.getCount() : prim.getAttribute('POSITION')!.getCount()) / 3;
  }
  return total;
}

export function vertexCount(doc: Document): number {
  return listPrimitives(doc).reduce((sum, p) => sum + p.getAttribute('POSITION')!.getCount(), 0);
}
