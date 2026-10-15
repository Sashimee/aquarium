import type { Primitive } from '@gltf-transform/core';
import { compactPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import {
  FIN_ID_ATTRIBUTE,
  FIN_MASK_ATTRIBUTE,
  LEG_ATTRIBUTE,
  MOUTH_ATTRIBUTE,
  SWAY_ATTRIBUTE,
} from './index-schema.ts';

export interface SimplifyOptions {
  /** Fraction of the primitive's triangles to keep. */
  ratio: number;
  /** Never reduce below this many triangles. */
  minTriangles: number;
}

const GUIDE_ATTRIBUTES: { semantic: string; size: number; weight: number }[] = [
  { semantic: 'NORMAL', size: 3, weight: 0.6 },
  { semantic: 'TEXCOORD_0', size: 2, weight: 1.2 },
  { semantic: FIN_MASK_ATTRIBUTE, size: 1, weight: 3 },
  { semantic: FIN_ID_ATTRIBUTE, size: 1, weight: 3 },
  { semantic: MOUTH_ATTRIBUTE, size: 1, weight: 3 },
  { semantic: SWAY_ATTRIBUTE, size: 1, weight: 3 },
  { semantic: LEG_ATTRIBUTE, size: 1, weight: 3 },
];

export function triangleCountOf(prim: Primitive): number {
  const indices = prim.getIndices();
  return (indices ? indices.getCount() : prim.getAttribute('POSITION')!.getCount()) / 3;
}

export function simplifyPrimitive(prim: Primitive, options: SimplifyOptions): void {
  const indicesAccessor = prim.getIndices();
  if (!indicesAccessor)
    throw new Error('simplifyPrimitive: primitive must be indexed; weld it first');
  const triangles = indicesAccessor.getCount() / 3;
  const target = Math.min(
    triangles,
    Math.max(options.minTriangles, Math.round(triangles * options.ratio)),
  );
  if (target >= triangles) return;

  const position = prim.getAttribute('POSITION')!;
  const vertexCount = position.getCount();
  const positions = Float32Array.from(position.getArray()!);
  const guides = GUIDE_ATTRIBUTES.filter((g) => prim.getAttribute(g.semantic));
  const stride = guides.reduce((sum, g) => sum + g.size, 0);
  const attributes = new Float32Array(vertexCount * stride);
  const weights: number[] = [];
  let offset = 0;
  const element: number[] = [];
  for (const guide of guides) {
    const accessor = prim.getAttribute(guide.semantic)!;
    for (let v = 0; v < vertexCount; v++) {
      accessor.getElement(v, element);
      for (let k = 0; k < guide.size; k++) attributes[v * stride + offset + k] = element[k]!;
    }
    for (let k = 0; k < guide.size; k++) weights.push(guide.weight);
    offset += guide.size;
  }

  const indices = Uint32Array.from(indicesAccessor.getArray()!);
  const [simplified] = MeshoptSimplifier.simplifyWithAttributes(
    indices,
    positions,
    3,
    attributes,
    stride,
    weights,
    null,
    target * 3,
    1,
    ['Permissive'],
  );
  if (simplified.length === 0)
    throw new Error('simplifyPrimitive: simplification removed every triangle');
  indicesAccessor.setArray(Uint32Array.from(simplified));
  compactPrimitive(prim);
}
