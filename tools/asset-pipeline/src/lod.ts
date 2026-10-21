import type { Primitive } from '@gltf-transform/core';
import { compactPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { boundsOf, canonicalVertices, connectedComponents } from './crew-scan.ts';
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
  /** Forbid collapses across attribute seams, so a UV chart boundary survives simplification. */
  keepSeams?: boolean;
}

const GUIDE_ATTRIBUTES: { semantic: string; size: number; weight: number }[] = [
  { semantic: 'NORMAL', size: 3, weight: 0.6 },
  { semantic: 'TEXCOORD_0', size: 2, weight: 1.2 },
  { semantic: FIN_MASK_ATTRIBUTE, size: 1, weight: 3 },
  { semantic: FIN_ID_ATTRIBUTE, size: 1, weight: 3 },
  { semantic: MOUTH_ATTRIBUTE, size: 1, weight: 0.5 },
  { semantic: SWAY_ATTRIBUTE, size: 1, weight: 3 },
  { semantic: LEG_ATTRIBUTE, size: 1, weight: 3 },
];

function keepComponents(prim: Primitive, keep: (sizes: number[], label: number) => boolean): void {
  const indicesAccessor = prim.getIndices();
  if (!indicesAccessor) throw new Error('keepComponents: primitive must be indexed');
  const positions = prim.getAttribute('POSITION')!.getArray()!;
  const bounds = boundsOf(positions);
  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  const canon = canonicalVertices(positions, diagonal / 4000);
  const source = indicesAccessor.getArray()!;
  const solid: number[] = [];
  for (let t = 0; t < source.length; t += 3) {
    const a = canon[source[t]!]!;
    const b = canon[source[t + 1]!]!;
    const c = canon[source[t + 2]!]!;
    if (a !== b && b !== c && a !== c) solid.push(source[t]!, source[t + 1]!, source[t + 2]!);
  }
  const components = connectedComponents(canon, solid, () => true);
  const kept: number[] = [];
  for (let t = 0; t < solid.length; t += 3)
    if (keep(components.sizes, components.label[solid[t]!]!))
      kept.push(solid[t]!, solid[t + 1]!, solid[t + 2]!);
  indicesAccessor.setArray(Uint32Array.from(kept));
  compactPrimitive(prim);
}

/** Drops zero-area triangles, then every triangle outside the largest position-welded component, so simplified thin parts cannot leave floating flecks. */
export function keepMainComponent(prim: Primitive): void {
  keepComponents(prim, (_, label) => label === 0);
}

/** Like `keepMainComponent`, but keeps every component with at least `minShare` of the largest one's vertices: a model made of separate bodies loses only its flecks. */
export function keepLargeComponents(minShare: number): (prim: Primitive) => void {
  return (prim) => keepComponents(prim, (sizes, label) => sizes[label]! >= minShare * sizes[0]!);
}

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
    const weight = options.keepSeams && guide.semantic === 'NORMAL' ? 8 : guide.weight;
    for (let k = 0; k < guide.size; k++) weights.push(weight);
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
    options.keepSeams ? [] : ['Permissive'],
  );
  if (simplified.length === 0)
    throw new Error('simplifyPrimitive: simplification removed every triangle');
  indicesAccessor.setArray(Uint32Array.from(simplified));
  compactPrimitive(prim);
}
