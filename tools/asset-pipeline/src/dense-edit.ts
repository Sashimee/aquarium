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

/** Drops every triangle whose centroid lies inside the sphere, through all layers of a thin wall, so its tunnels and folds go with it. */
export function cutSphere(dense: Dense, centre: [number, number, number], radius: number): Dense {
  const kept: number[] = [];
  const at = (v: number, c: number): number => dense.positions[v * 3 + c]!;
  for (let t = 0; t < dense.indices.length; t += 3) {
    const [a, b, c] = [dense.indices[t]!, dense.indices[t + 1]!, dense.indices[t + 2]!];
    const mean = [0, 1, 2].map((k) => (at(a, k) + at(b, k) + at(c, k)) / 3);
    if (Math.hypot(mean[0]! - centre[0], mean[1]! - centre[1], mean[2]! - centre[2]) > radius)
      kept.push(a, b, c);
  }
  return compactDense(dense, Uint32Array.from(kept));
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

/**
 * Closes every boundary loop of at most `maxLoop` vertices by clipping ears, shortest diagonal first. Unlike a centroid
 * fan this adds no vertices and zips the two sides of a long thin ribbon (a cut through a paper-thin wall) together.
 */
export function earClipLoops(dense: Dense, maxLoop: number): Dense {
  const at = (v: number, c: number): number => dense.positions[v * 3 + c]!;
  const span = (a: number, b: number): number =>
    Math.hypot(at(a, 0) - at(b, 0), at(a, 1) - at(b, 1), at(a, 2) - at(b, 2));
  const indices = Array.from(dense.indices);
  for (const loop of boundaryLoops(dense.indices)) {
    if (loop.length > maxLoop) continue;
    const ring = [...loop];
    while (ring.length > 3) {
      let best = 0;
      let shortest = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const d = span(ring[(i + ring.length - 1) % ring.length]!, ring[(i + 1) % ring.length]!);
        if (d < shortest) {
          shortest = d;
          best = i;
        }
      }
      indices.push(
        ring[(best + 1) % ring.length]!,
        ring[best]!,
        ring[(best + ring.length - 1) % ring.length]!,
      );
      ring.splice(best, 1);
    }
    indices.push(ring[1]!, ring[0]!, ring[2]!);
  }
  return { ...dense, indices: Uint32Array.from(indices) };
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
