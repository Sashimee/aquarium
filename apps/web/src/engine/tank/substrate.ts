import { BufferGeometry, Float32BufferAttribute, MeshStandardNodeMaterial } from 'three/webgpu';
import { color, mix, mx_noise_float, positionWorld, smoothstep } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TankDimensions } from './dimensions';

/**
 * Height of the substrate top at (x, z): a slope rising towards the back (-z), the
 * usual aquascaping layout, with low dunes.
 */
export function substrateHeight(d: TankDimensions, x: number, z: number): number {
  const innerDepth = d.depth - 2 * d.glass;
  const back = Math.min(1, Math.max(0, (innerDepth / 2 - z) / innerDepth));
  const eased = back * back * (3 - 2 * back);
  const dunes =
    0.004 * Math.sin(x * 21 + z * 6) +
    0.003 * Math.sin(-x * 9.5 + z * 29) +
    0.0015 * Math.sin(x * 47 - z * 13);
  return d.glass + d.substrateFront + (d.substrateBack - d.substrateFront) * eased + dunes;
}

function topSurface(d: TankDimensions, nx: number, nz: number): BufferGeometry {
  const halfL = d.length / 2 - d.glass;
  const halfD = d.depth / 2 - d.glass;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let j = 0; j <= nz; j++) {
    const z = -halfD + (2 * halfD * j) / nz;
    for (let i = 0; i <= nx; i++) {
      const x = -halfL + (2 * halfL * i) / nx;
      positions.push(x, substrateHeight(d, x, z), z);
      uvs.push(i / nx, j / nz);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const e = c + 1;
      index.push(a, c, b, b, c, e);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry.toNonIndexed();
}

/** The four cut faces of the substrate, visible through the glass. */
function sideWalls(d: TankDimensions, segments: number): BufferGeometry {
  const halfL = d.length / 2 - d.glass;
  const halfD = d.depth / 2 - d.glass;
  const floor = d.glass;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const wall = (
    from: [number, number],
    to: [number, number],
    normal: [number, number, number],
  ): void => {
    for (let s = 0; s < segments; s++) {
      const t0 = s / segments;
      const t1 = (s + 1) / segments;
      const x0 = from[0] + (to[0] - from[0]) * t0;
      const z0 = from[1] + (to[1] - from[1]) * t0;
      const x1 = from[0] + (to[0] - from[0]) * t1;
      const z1 = from[1] + (to[1] - from[1]) * t1;
      const y0 = substrateHeight(d, x0, z0);
      const y1 = substrateHeight(d, x1, z1);
      positions.push(x0, floor, z0, x1, floor, z1, x1, y1, z1);
      positions.push(x0, floor, z0, x1, y1, z1, x0, y0, z0);
      for (let k = 0; k < 6; k++) normals.push(...normal);
      uvs.push(t0, 0, t1, 0, t1, 1, t0, 0, t1, 1, t0, 1);
    }
  };

  wall([-halfL, halfD], [halfL, halfD], [0, 0, 1]);
  wall([halfL, -halfD], [-halfL, -halfD], [0, 0, -1]);
  wall([halfL, halfD], [halfL, -halfD], [1, 0, 0]);
  wall([-halfL, -halfD], [-halfL, halfD], [-1, 0, 0]);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return geometry;
}

export function createSubstrateGeometry(d: TankDimensions): BufferGeometry {
  const top = topSurface(d, 120, 50);
  const walls = sideWalls(d, 120);
  const merged = mergeGeometries([top, walls]);
  top.dispose();
  walls.dispose();
  return merged;
}

/** Placeholder sand until the scene presets (T11) bring textured substrates. */
export function createSubstrateMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const sand = color(0xb8a27c);
  const dark = color(0x6f5f47);
  const grain = mx_noise_float(positionWorld.mul(260)).mul(0.5).add(0.5);
  const patches = mx_noise_float(positionWorld.mul(9)).mul(0.5).add(0.5);
  const tone = smoothstep(0.25, 0.85, grain.mul(0.55).add(patches.mul(0.45)));
  material.colorNode = mix(dark, sand, tone.mul(0.6).add(0.4));
  material.name = 'substrate';
  return material;
}
