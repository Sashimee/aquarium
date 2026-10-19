import { compactDense, type Dense } from './rebake.ts';

export function vertexNeighbours(indices: Uint32Array, vertexCount: number): number[][] {
  const sets: Set<number>[] = Array.from({ length: vertexCount }, () => new Set());
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]!;
      const b = indices[t + ((k + 1) % 3)]!;
      sets[a]!.add(b);
      sets[b]!.add(a);
    }
  return sets.map((s) => [...s].sort((x, y) => x - y));
}

/** Directed boundary half-edges (edges used by exactly one triangle), keyed by their start vertex. */
function boundaryHalfEdges(indices: Uint32Array): Map<number, number[]> {
  const count = new Map<string, number>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(indices[t + k]!, indices[t + ((k + 1) % 3)]!);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  const next = new Map<number, number[]>();
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]!;
      const b = indices[t + ((k + 1) % 3)]!;
      if (count.get(edgeKey(a, b)) === 1) (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    }
  return next;
}

/** Closed chains of boundary vertices, each in the winding direction of the triangles that own them. */
export function boundaryLoops(indices: Uint32Array): number[][] {
  const next = boundaryHalfEdges(indices);
  const used = new Set<number>();
  const loops: number[][] = [];
  for (const start of [...next.keys()].sort((a, b) => a - b)) {
    if (used.has(start)) continue;
    const loop = [start];
    used.add(start);
    let at = next.get(start)![0]!;
    while (at !== start && !used.has(at)) {
      loop.push(at);
      used.add(at);
      const options = next.get(at);
      if (!options) break;
      at = options[0]!;
    }
    loops.push(loop);
  }
  return loops;
}

/** Drops every triangle touching the open boundary, `layers` times over: removes scan fuzz and slivers on a rim. */
export function peelBoundary(dense: Dense, layers: number): Dense {
  let indices = dense.indices;
  for (let layer = 0; layer < layers; layer++) {
    const edge = new Set<number>();
    for (const [a, ends] of boundaryHalfEdges(indices)) {
      edge.add(a);
      for (const b of ends) edge.add(b);
    }
    const kept: number[] = [];
    for (let t = 0; t < indices.length; t += 3)
      if (!edge.has(indices[t]!) && !edge.has(indices[t + 1]!) && !edge.has(indices[t + 2]!))
        kept.push(indices[t]!, indices[t + 1]!, indices[t + 2]!);
    indices = Uint32Array.from(kept);
  }
  return compactDense(dense, indices);
}

/** Closes every boundary loop of at most `maxLoop` vertices with a fan around its centroid. */
export function fillSmallHoles(dense: Dense, maxLoop: number): Dense {
  const positions = Array.from(dense.positions);
  const colours = Array.from(dense.colours);
  const extra: Record<string, number[]> = {};
  for (const [key, values] of Object.entries(dense.extra)) extra[key] = Array.from(values);
  const indices = Array.from(dense.indices);
  for (const loop of boundaryLoops(dense.indices)) {
    if (loop.length > maxLoop) continue;
    const centre = positions.length / 3;
    const mean = (source: ArrayLike<number>): number[] =>
      [0, 1, 2].map((c) => loop.reduce((s, v) => s + source[v * 3 + c]!, 0) / loop.length);
    positions.push(...mean(dense.positions));
    colours.push(...mean(dense.colours));
    for (const [key, values] of Object.entries(dense.extra)) extra[key]!.push(values[loop[0]!]!);
    loop.forEach((a, k) => indices.push(loop[(k + 1) % loop.length]!, a, centre));
  }
  const result: Dense = {
    positions: Float32Array.from(positions),
    colours: Float32Array.from(colours),
    indices: Uint32Array.from(indices),
    extra: {},
  };
  for (const [key, values] of Object.entries(extra)) result.extra[key] = Float32Array.from(values);
  return result;
}

/** Relaxes the open rim, then the rings inside it, so a ragged scan edge becomes one smooth curve. */
export function smoothRim(dense: Dense, iterations: number, rings: number, minLoop = 8): void {
  const count = dense.positions.length / 3;
  const loops = boundaryLoops(dense.indices).filter((l) => l.length > minLoop);
  for (let it = 0; it < iterations; it++) {
    const next = Float32Array.from(dense.positions);
    for (const loop of loops)
      loop.forEach((v, k) => {
        const a = loop[(k + loop.length - 1) % loop.length]!;
        const b = loop[(k + 1) % loop.length]!;
        for (let c = 0; c < 3; c++)
          next[v * 3 + c] =
            0.5 * dense.positions[v * 3 + c]! +
            0.25 * (dense.positions[a * 3 + c]! + dense.positions[b * 3 + c]!);
      });
    dense.positions.set(next);
  }
  const neighbours = vertexNeighbours(dense.indices, count);
  const inside = new Uint8Array(count);
  let frontier = loops.flat();
  const seen = new Uint8Array(count);
  frontier.forEach((v) => (seen[v] = 1));
  for (let ring = 1; ring <= rings; ring++) {
    const grown: number[] = [];
    for (const v of frontier)
      for (const n of neighbours[v]!)
        if (!seen[n]) {
          seen[n] = 1;
          inside[n] = 1;
          grown.push(n);
        }
    frontier = grown;
  }
  for (let it = 0; it < iterations; it++) {
    const next = Float32Array.from(dense.positions);
    for (let v = 0; v < count; v++) {
      if (!inside[v]) continue;
      const around = neighbours[v]!;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (const n of around) sum += dense.positions[n * 3 + c]!;
        next[v * 3 + c] = 0.5 * dense.positions[v * 3 + c]! + 0.5 * (sum / around.length);
      }
    }
    dense.positions.set(next);
  }
}

/** Replaces the colour of every masked vertex with what diffuses in from the unmasked ones around it. */
export function inpaintColours(dense: Dense, masked: Uint8Array, relax = 12): void {
  const count = dense.positions.length / 3;
  const neighbours = vertexNeighbours(dense.indices, count);
  const known = Uint8Array.from(masked, (m) => (m ? 0 : 1));
  for (;;) {
    const fill: [number, number[]][] = [];
    for (let v = 0; v < count; v++) {
      if (known[v]) continue;
      const have = neighbours[v]!.filter((n) => known[n]);
      if (have.length > 0) fill.push([v, have]);
    }
    if (fill.length === 0) break;
    for (const [v, have] of fill)
      for (let c = 0; c < 3; c++)
        dense.colours[v * 3 + c] =
          have.reduce((s, n) => s + dense.colours[n * 3 + c]!, 0) / have.length;
    for (const [v] of fill) known[v] = 1;
  }
  for (let it = 0; it < relax; it++) {
    const next = Float32Array.from(dense.colours);
    for (let v = 0; v < count; v++) {
      if (!masked[v]) continue;
      const around = neighbours[v]!;
      if (around.length === 0) continue;
      for (let c = 0; c < 3; c++)
        next[v * 3 + c] = around.reduce((s, n) => s + dense.colours[n * 3 + c]!, 0) / around.length;
    }
    dense.colours.set(next);
  }
}

export function growMask(dense: Dense, mask: Uint8Array, rings: number): Uint8Array {
  const neighbours = vertexNeighbours(dense.indices, mask.length);
  let current = mask;
  for (let r = 0; r < rings; r++) {
    const next = Uint8Array.from(current);
    for (let v = 0; v < mask.length; v++)
      if (current[v]) for (const n of neighbours[v]!) next[n] = 1;
    current = next;
  }
  return current;
}

/** Laplacian-relaxes the masked vertices, which rounds off saw-teeth without touching the smooth surface around. */
export function smoothMasked(
  dense: Dense,
  mask: Uint8Array,
  iterations: number,
  weight = 0.5,
): void {
  const count = dense.positions.length / 3;
  const neighbours = vertexNeighbours(dense.indices, count);
  for (let it = 0; it < iterations; it++) {
    const next = Float32Array.from(dense.positions);
    for (let v = 0; v < count; v++) {
      const around = neighbours[v]!;
      if (!mask[v] || around.length === 0) continue;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (const n of around) sum += dense.positions[n * 3 + c]!;
        next[v * 3 + c] =
          (1 - weight) * dense.positions[v * 3 + c]! + weight * (sum / around.length);
      }
    }
    dense.positions.set(next);
  }
}
