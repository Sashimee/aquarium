export function pairwiseDistanceSq(pos: Float64Array, n: number, out: Float64Array): void {
  for (let i = 0; i < n; i++) {
    const ix = pos[i * 3] ?? 0;
    const iy = pos[i * 3 + 1] ?? 0;
    const iz = pos[i * 3 + 2] ?? 0;
    out[i * n + i] = 0;
    for (let j = i + 1; j < n; j++) {
      const dx = (pos[j * 3] ?? 0) - ix;
      const dy = (pos[j * 3 + 1] ?? 0) - iy;
      const dz = (pos[j * 3 + 2] ?? 0) - iz;
      const d = dx * dx + dy * dy + dz * dz;
      out[i * n + j] = d;
      out[j * n + i] = d;
    }
  }
}

/**
 * Topological neighbourhood: the `k` nearest others of fish `i`, regardless of how far they are
 * (Ballerini et al. 2008), optionally restricted to one group and to `maxDistSq`. Writes indices
 * nearest-first into `out[outOffset..]` and returns how many were found. Ties keep the lower index,
 * so the result is deterministic.
 */
export function selectNearest(
  distSq: Float64Array,
  n: number,
  i: number,
  k: number,
  group: Int32Array | null,
  maxDistSq: number,
  out: Int32Array,
  outOffset: number,
  scratchDist: Float64Array,
): number {
  if (k <= 0) return 0;
  const g = group === null ? -1 : (group[i] ?? -1);
  let count = 0;
  const row = i * n;
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    if (group !== null && group[j] !== g) continue;
    const d = distSq[row + j] ?? Infinity;
    if (d > maxDistSq) continue;
    if (count === k && d >= (scratchDist[k - 1] ?? Infinity)) continue;
    let slot = count < k ? count++ : k - 1;
    while (slot > 0 && (scratchDist[slot - 1] ?? Infinity) > d) {
      scratchDist[slot] = scratchDist[slot - 1] ?? Infinity;
      out[outOffset + slot] = out[outOffset + slot - 1] ?? -1;
      slot--;
    }
    scratchDist[slot] = d;
    out[outOffset + slot] = j;
  }
  return count;
}
