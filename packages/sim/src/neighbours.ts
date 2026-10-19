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

/** Work space for `selectBalanced`: `idx` and `dist` hold at least the pool, `dir` 3 × k. */
export interface BalancedScratch {
  readonly idx: Int32Array;
  readonly dist: Float64Array;
  readonly dir: Float64Array;
}

/**
 * Spatially balanced topological neighbourhood (Camperi et al. 2012): the nearest others of fish
 * `i` within `maxDistSq`, nearest first, skipping any seen within the angle whose cosine is
 * `minAngleCos` of one already taken, up to `k`, from the `pool` nearest. Plain k-nearest lets a
 * large school break into subgroups of about k that each see only themselves; skipping a crowded
 * bearing reaches past the fish's own clump to the next one.
 */
export function selectBalanced(
  distSq: Float64Array,
  pos: Float64Array,
  n: number,
  i: number,
  k: number,
  pool: number,
  group: Int32Array | null,
  maxDistSq: number,
  minAngleCos: number,
  out: Int32Array,
  outOffset: number,
  scratch: BalancedScratch,
): number {
  const { idx, dist, dir } = scratch;
  const found = selectNearest(distSq, n, i, pool, group, maxDistSq, idx, 0, dist);
  const px = pos[i * 3] ?? 0;
  const py = pos[i * 3 + 1] ?? 0;
  const pz = pos[i * 3 + 2] ?? 0;
  let count = 0;
  let directions = 0;
  for (let c = 0; c < found && count < k; c++) {
    const j = idx[c] ?? 0;
    const dj = Math.sqrt(dist[c] ?? 0);
    if (dj < 1e-12) {
      out[outOffset + count++] = j;
      continue;
    }
    const ux = ((pos[j * 3] ?? 0) - px) / dj;
    const uy = ((pos[j * 3 + 1] ?? 0) - py) / dj;
    const uz = ((pos[j * 3 + 2] ?? 0) - pz) / dj;
    let crowded = false;
    for (let m = 0; m < directions * 3; m += 3) {
      if (ux * (dir[m] ?? 0) + uy * (dir[m + 1] ?? 0) + uz * (dir[m + 2] ?? 0) > minAngleCos) {
        crowded = true;
        break;
      }
    }
    if (crowded) continue;
    out[outOffset + count++] = j;
    dir[directions * 3] = ux;
    dir[directions * 3 + 1] = uy;
    dir[directions * 3 + 2] = uz;
    directions++;
  }
  return count;
}
