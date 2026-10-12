export interface VoxelGrid {
  nx: number;
  ny: number;
  nz: number;
  size: number;
  origin: [number, number, number];
  data: Uint8Array;
}

export function createGrid(
  min: [number, number, number],
  max: [number, number, number],
  size: number,
  pad: number,
): VoxelGrid {
  const nx = Math.ceil((max[0] - min[0]) / size) + 2 * pad + 1;
  const ny = Math.ceil((max[1] - min[1]) / size) + 2 * pad + 1;
  const nz = Math.ceil((max[2] - min[2]) / size) + 2 * pad + 1;
  return {
    nx,
    ny,
    nz,
    size,
    origin: [min[0] - pad * size, min[1] - pad * size, min[2] - pad * size],
    data: new Uint8Array(nx * ny * nz),
  };
}

export function voxelIndex(grid: VoxelGrid, x: number, y: number, z: number): number {
  return (z * grid.ny + y) * grid.nx + x;
}

export function toCell(grid: VoxelGrid, p: number, axis: 0 | 1 | 2): number {
  return Math.floor((p - grid.origin[axis]) / grid.size);
}

/** Marks every voxel a triangle touches by sampling it more densely than the voxel size. */
export function rasteriseSurface(
  grid: VoxelGrid,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): void {
  const step = grid.size * 0.4;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ab = Math.hypot(
      positions[b]! - positions[a]!,
      positions[b + 1]! - positions[a + 1]!,
      positions[b + 2]! - positions[a + 2]!,
    );
    const ac = Math.hypot(
      positions[c]! - positions[a]!,
      positions[c + 1]! - positions[a + 1]!,
      positions[c + 2]! - positions[a + 2]!,
    );
    const bc = Math.hypot(
      positions[c]! - positions[b]!,
      positions[c + 1]! - positions[b + 1]!,
      positions[c + 2]! - positions[b + 2]!,
    );
    const n = Math.max(1, Math.ceil(Math.max(ab, ac, bc) / step));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n;
        const v = j / n;
        const w = 1 - u - v;
        const x = w * positions[a]! + u * positions[b]! + v * positions[c]!;
        const y = w * positions[a + 1]! + u * positions[b + 1]! + v * positions[c + 1]!;
        const z = w * positions[a + 2]! + u * positions[b + 2]! + v * positions[c + 2]!;
        const cx = toCell(grid, x, 0);
        const cy = toCell(grid, y, 1);
        const cz = toCell(grid, z, 2);
        if (cx < 0 || cy < 0 || cz < 0 || cx >= grid.nx || cy >= grid.ny || cz >= grid.nz) continue;
        grid.data[voxelIndex(grid, cx, cy, cz)] = 1;
      }
    }
  }
}

const NEIGHBOURS6: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function dilate6(grid: VoxelGrid): Uint8Array {
  const out = Uint8Array.from(grid.data);
  for (let z = 0; z < grid.nz; z++)
    for (let y = 0; y < grid.ny; y++)
      for (let x = 0; x < grid.nx; x++) {
        if (!grid.data[voxelIndex(grid, x, y, z)]) continue;
        for (const [dx, dy, dz] of NEIGHBOURS6) {
          const px = x + dx;
          const py = y + dy;
          const pz = z + dz;
          if (px < 0 || py < 0 || pz < 0 || px >= grid.nx || py >= grid.ny || pz >= grid.nz)
            continue;
          out[voxelIndex(grid, px, py, pz)] = 1;
        }
      }
  return out;
}

/** Solid interior of a surface voxelisation: everything the outside flood fill cannot reach. */
export function fillSolid(grid: VoxelGrid): Uint8Array {
  const sealed = dilate6(grid);
  const outside = new Uint8Array(sealed.length);
  const stack: number[] = [0];
  outside[0] = 1;
  while (stack.length > 0) {
    const current = stack.pop()!;
    const x = current % grid.nx;
    const y = Math.floor(current / grid.nx) % grid.ny;
    const z = Math.floor(current / (grid.nx * grid.ny));
    for (const [dx, dy, dz] of NEIGHBOURS6) {
      const px = x + dx;
      const py = y + dy;
      const pz = z + dz;
      if (px < 0 || py < 0 || pz < 0 || px >= grid.nx || py >= grid.ny || pz >= grid.nz) continue;
      const next = voxelIndex(grid, px, py, pz);
      if (outside[next] || sealed[next]) continue;
      outside[next] = 1;
      stack.push(next);
    }
  }
  const inflated = new Uint8Array(sealed.length);
  for (let i = 0; i < inflated.length; i++) inflated[i] = outside[i] ? 0 : 1;
  return erode6({ ...grid, data: inflated });
}

function erode6(grid: VoxelGrid): Uint8Array {
  const out = new Uint8Array(grid.data.length);
  for (let z = 0; z < grid.nz; z++)
    for (let y = 0; y < grid.ny; y++)
      for (let x = 0; x < grid.nx; x++) {
        const index = voxelIndex(grid, x, y, z);
        if (!grid.data[index]) continue;
        let keep = true;
        for (const [dx, dy, dz] of NEIGHBOURS6) {
          const px = x + dx;
          const py = y + dy;
          const pz = z + dz;
          const inside =
            px >= 0 && py >= 0 && pz >= 0 && px < grid.nx && py < grid.ny && pz < grid.nz;
          if (inside && !grid.data[voxelIndex(grid, px, py, pz)]) {
            keep = false;
            break;
          }
        }
        out[index] = keep ? 1 : 0;
      }
  return out;
}

const INF = 1e12;

function distanceTransform1d(
  f: Float64Array,
  n: number,
  out: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s: number;
    for (;;) {
      const p = v[k]!;
      s = (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
      if (s > z[k]!) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    out[q] = (q - p) * (q - p) + f[p]!;
  }
}

/** Squared distance, in voxels, from every voxel to the nearest voxel where `mask` is set (Felzenszwalb-Huttenlocher). */
export function squaredDistance(grid: VoxelGrid, mask: Uint8Array): Float64Array {
  const { nx, ny, nz } = grid;
  const dist = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) dist[i] = mask[i] ? 0 : INF;
  const longest = Math.max(nx, ny, nz);
  const f = new Float64Array(longest);
  const out = new Float64Array(longest);
  const v = new Int32Array(longest);
  const z = new Float64Array(longest + 1);
  for (let zi = 0; zi < nz; zi++)
    for (let yi = 0; yi < ny; yi++) {
      for (let x = 0; x < nx; x++) f[x] = dist[voxelIndex(grid, x, yi, zi)]!;
      distanceTransform1d(f, nx, out, v, z);
      for (let x = 0; x < nx; x++) dist[voxelIndex(grid, x, yi, zi)] = out[x]!;
    }
  for (let zi = 0; zi < nz; zi++)
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) f[y] = dist[voxelIndex(grid, x, y, zi)]!;
      distanceTransform1d(f, ny, out, v, z);
      for (let y = 0; y < ny; y++) dist[voxelIndex(grid, x, y, zi)] = out[y]!;
    }
  for (let yi = 0; yi < ny; yi++)
    for (let x = 0; x < nx; x++) {
      for (let zz = 0; zz < nz; zz++) f[zz] = dist[voxelIndex(grid, x, yi, zz)]!;
      distanceTransform1d(f, nz, out, v, z);
      for (let zz = 0; zz < nz; zz++) dist[voxelIndex(grid, x, yi, zz)] = out[zz]!;
    }
  return dist;
}

/** Morphological opening by a Euclidean ball: removes anything thinner than twice the radius, keeps the bulk. */
export function open(grid: VoxelGrid, solid: Uint8Array, radiusVoxels: number): Uint8Array {
  const toBackground = new Uint8Array(solid.length);
  for (let i = 0; i < solid.length; i++) toBackground[i] = solid[i] ? 0 : 1;
  const inside = squaredDistance(grid, toBackground);
  const eroded = new Uint8Array(solid.length);
  const r2 = radiusVoxels * radiusVoxels;
  for (let i = 0; i < solid.length; i++) eroded[i] = inside[i]! > r2 ? 1 : 0;
  const reach = squaredDistance(grid, eroded);
  const opened = new Uint8Array(solid.length);
  for (let i = 0; i < solid.length; i++) opened[i] = reach[i]! <= r2 ? 1 : 0;
  return opened;
}
