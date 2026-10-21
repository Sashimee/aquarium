import type { Rgba } from './textures.ts';

export interface MipTexture {
  levels: { width: number; height: number; data: Uint8Array }[];
}

export interface SceneMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  texture: MipTexture;
  /** Multiplies the texture colour, 1 leaves it unchanged. */
  tint?: readonly [number, number, number];
  /** Receive-only meshes (a floor) are left out of the shadow map. */
  castsShadow: boolean;
}

export interface Instance {
  mesh: SceneMesh;
  position: readonly [number, number, number];
  yawDeg: number;
  scale: number;
}

export interface SceneCamera {
  position: readonly [number, number, number];
  /** Degrees below the horizon the camera looks; negative looks up. */
  pitchDeg: number;
  hfovDeg: number;
  near: number;
}

export interface SceneLighting {
  /** Unit vector from the scene toward the light. */
  toLight: readonly [number, number, number];
  ambient: number;
  diffuse: number;
  shadowStrength: number;
}

export interface SceneSpec {
  width: number;
  height: number;
  camera: SceneCamera;
  lighting: SceneLighting;
  instances: Instance[];
  /** RGB drawn where no geometry covers a pixel; its depth is the far value. */
  empty: readonly [number, number, number];
  far: number;
}

function mipLevel(levels: MipTexture['levels'], index: number): MipTexture['levels'][number] {
  const level = levels[index];
  if (!level) throw new Error(`mip level ${index} does not exist`);
  return level;
}

export function buildMips(image: Rgba): MipTexture {
  const levels = [{ width: image.width, height: image.height, data: image.data }];
  for (;;) {
    const last = mipLevel(levels, levels.length - 1);
    if (last.width <= 1 && last.height <= 1) break;
    const width = Math.max(1, last.width >> 1);
    const height = Math.max(1, last.height >> 1);
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 4; c++) {
          const x1 = Math.min(last.width - 1, x * 2 + 1);
          const y1 = Math.min(last.height - 1, y * 2 + 1);
          const sum =
            (last.data[(y * 2 * last.width + x * 2) * 4 + c] ?? 0) +
            (last.data[(y * 2 * last.width + x1) * 4 + c] ?? 0) +
            (last.data[(y1 * last.width + x * 2) * 4 + c] ?? 0) +
            (last.data[(y1 * last.width + x1) * 4 + c] ?? 0);
          data[(y * width + x) * 4 + c] = (sum + 2) >> 2;
        }
    levels.push({ width, height, data });
  }
  return { levels };
}

function sampleLevel(
  level: MipTexture['levels'][number],
  u: number,
  v: number,
  out: [number, number, number],
): void {
  const fx = (u - Math.floor(u)) * level.width - 0.5;
  const fy = (v - Math.floor(v)) * level.height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const wrapX = (x: number): number => ((x % level.width) + level.width) % level.width;
  const wrapY = (y: number): number => ((y % level.height) + level.height) % level.height;
  const xa = wrapX(x0);
  const xb = wrapX(x0 + 1);
  const ya = wrapY(y0);
  const yb = wrapY(y0 + 1);
  for (let c = 0; c < 3; c++) {
    const top =
      (level.data[(ya * level.width + xa) * 4 + c] ?? 0) * (1 - tx) +
      (level.data[(ya * level.width + xb) * 4 + c] ?? 0) * tx;
    const bottom =
      (level.data[(yb * level.width + xa) * 4 + c] ?? 0) * (1 - tx) +
      (level.data[(yb * level.width + xb) * 4 + c] ?? 0) * tx;
    out[c] = top * (1 - ty) + bottom * ty;
  }
}

interface WorldMesh {
  mesh: SceneMesh;
  positions: Float32Array;
  normals: Float32Array;
}

function toWorld(instance: Instance): WorldMesh {
  const { mesh } = instance;
  const yaw = (instance.yawDeg * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = (mesh.positions[i] ?? 0) * instance.scale;
    const z = (mesh.positions[i + 2] ?? 0) * instance.scale;
    positions[i] = x * cos + z * sin + instance.position[0];
    positions[i + 1] = (mesh.positions[i + 1] ?? 0) * instance.scale + instance.position[1];
    positions[i + 2] = -x * sin + z * cos + instance.position[2];
    const nx = mesh.normals[i] ?? 0;
    const nz = mesh.normals[i + 2] ?? 0;
    normals[i] = nx * cos + nz * sin;
    normals[i + 1] = mesh.normals[i + 1] ?? 0;
    normals[i + 2] = -nx * sin + nz * cos;
  }
  return { mesh, positions, normals };
}

interface ShadowMap {
  size: number;
  depth: Float32Array;
  ax: [number, number, number];
  ay: [number, number, number];
  toLight: readonly [number, number, number];
  minU: number;
  minV: number;
  scale: number;
}

const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

function normalise(v: readonly number[]): [number, number, number] {
  const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  return [(v[0] ?? 0) / length, (v[1] ?? 0) / length, (v[2] ?? 0) / length];
}

function buildShadowMap(
  meshes: WorldMesh[],
  toLightRaw: readonly [number, number, number],
  size: number,
): ShadowMap | null {
  const casters = meshes.filter((m) => m.mesh.castsShadow);
  if (casters.length === 0) return null;
  const toLight = normalise(toLightRaw);
  const reference: [number, number, number] = Math.abs(toLight[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const ax = normalise(cross(reference, toLight));
  const ay = cross(toLight, ax);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const { positions } of casters)
    for (let i = 0; i < positions.length; i += 3) {
      const p = [positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0];
      const u = dot(p, ax);
      const v = dot(p, ay);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  const scale = (size - 2) / Math.max(maxU - minU, maxV - minV);
  const depth = new Float32Array(size * size).fill(-Infinity);
  for (const { positions, mesh } of casters) {
    const sx = new Float32Array(3);
    const sy = new Float32Array(3);
    const sd = new Float32Array(3);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = (mesh.indices[t + k] ?? 0) * 3;
        const p = [positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0];
        sx[k] = (dot(p, ax) - minU) * scale + 1;
        sy[k] = (dot(p, ay) - minV) * scale + 1;
        sd[k] = dot(p, toLight);
      }
      const denom =
        ((sy[1] ?? 0) - (sy[2] ?? 0)) * ((sx[0] ?? 0) - (sx[2] ?? 0)) +
        ((sx[2] ?? 0) - (sx[1] ?? 0)) * ((sy[0] ?? 0) - (sy[2] ?? 0));
      if (Math.abs(denom) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(sx[0] ?? 0, sx[1] ?? 0, sx[2] ?? 0)));
      const x1 = Math.min(size - 1, Math.ceil(Math.max(sx[0] ?? 0, sx[1] ?? 0, sx[2] ?? 0)));
      const y0 = Math.max(0, Math.floor(Math.min(sy[0] ?? 0, sy[1] ?? 0, sy[2] ?? 0)));
      const y1 = Math.min(size - 1, Math.ceil(Math.max(sy[0] ?? 0, sy[1] ?? 0, sy[2] ?? 0)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const w0 =
            (((sy[1] ?? 0) - (sy[2] ?? 0)) * (x + 0.5 - (sx[2] ?? 0)) +
              ((sx[2] ?? 0) - (sx[1] ?? 0)) * (y + 0.5 - (sy[2] ?? 0))) /
            denom;
          const w1 =
            (((sy[2] ?? 0) - (sy[0] ?? 0)) * (x + 0.5 - (sx[2] ?? 0)) +
              ((sx[0] ?? 0) - (sx[2] ?? 0)) * (y + 0.5 - (sy[2] ?? 0))) /
            denom;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
          const d = w0 * (sd[0] ?? 0) + w1 * (sd[1] ?? 0) + w2 * (sd[2] ?? 0);
          if (d > (depth[y * size + x] ?? 0)) depth[y * size + x] = d;
        }
    }
  }
  return { size, depth, ax, ay, toLight, minU, minV, scale };
}

function litFraction(map: ShadowMap | null, p: readonly number[], bias: number): number {
  if (!map) return 1;
  const x = (dot(p, map.ax) - map.minU) * map.scale + 1;
  const y = (dot(p, map.ay) - map.minV) * map.scale + 1;
  if (x < 1 || y < 1 || x >= map.size - 2 || y >= map.size - 2) return 1;
  const d = dot(p, map.toLight);
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let lit = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++)
      if (d >= (map.depth[(cy + j) * map.size + cx + i] ?? 0) - bias) lit++;
  return lit / 9;
}

export interface Rendered {
  rgb: Uint8Array;
  /** View-space depth in scene units; `far` where nothing was drawn. */
  depth: Float32Array;
}

export function renderScene(spec: SceneSpec, shadowSize = 4096): Rendered {
  const { width, height, camera, lighting } = spec;
  const world = spec.instances.map(toWorld);
  const shadows = buildShadowMap(world, lighting.toLight, shadowSize);
  const toLight = normalise(lighting.toLight);

  const pitch = (camera.pitchDeg * Math.PI) / 180;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const focal = width / 2 / Math.tan((camera.hfovDeg * Math.PI) / 360);

  const depth = new Float32Array(width * height).fill(spec.far);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = spec.empty[0];
    rgb[i * 3 + 1] = spec.empty[1];
    rgb[i * 3 + 2] = spec.empty[2];
  }
  const zbuffer = new Float32Array(width * height).fill(Infinity);

  const sx = new Float64Array(3);
  const sy = new Float64Array(3);
  const iz = new Float64Array(3);
  const colour: [number, number, number] = [0, 0, 0];

  for (const { mesh, positions, normals } of world) {
    const cx = new Float64Array(mesh.positions.length / 3);
    const cy = new Float64Array(cx.length);
    const cz = new Float64Array(cx.length);
    for (let v = 0; v < cx.length; v++) {
      const rx = (positions[v * 3] ?? 0) - camera.position[0];
      const ry = (positions[v * 3 + 1] ?? 0) - camera.position[1];
      const rz = (positions[v * 3 + 2] ?? 0) - camera.position[2];
      cx[v] = rx;
      cy[v] = ry * cp - rz * sp;
      cz[v] = -ry * sp - rz * cp;
    }
    const texture = mesh.texture;
    const tint = mesh.tint ?? [1, 1, 1];
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t] ?? 0;
      const b = mesh.indices[t + 1] ?? 0;
      const c = mesh.indices[t + 2] ?? 0;
      const ids = [a, b, c];
      let behind = false;
      for (let k = 0; k < 3; k++) {
        const id = ids[k] ?? 0;
        const d = cz[id] ?? 0;
        if (d < camera.near) behind = true;
        const inverse = 1 / d;
        iz[k] = inverse;
        sx[k] = width / 2 + focal * (cx[id] ?? 0) * inverse;
        sy[k] = height / 2 - focal * (cy[id] ?? 0) * inverse;
      }
      if (behind) continue;
      const denom =
        ((sy[1] ?? 0) - (sy[2] ?? 0)) * ((sx[0] ?? 0) - (sx[2] ?? 0)) +
        ((sx[2] ?? 0) - (sx[1] ?? 0)) * ((sy[0] ?? 0) - (sy[2] ?? 0));
      if (Math.abs(denom) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(sx[0] ?? 0, sx[1] ?? 0, sx[2] ?? 0)));
      const x1 = Math.min(width - 1, Math.ceil(Math.max(sx[0] ?? 0, sx[1] ?? 0, sx[2] ?? 0)));
      const y0 = Math.max(0, Math.floor(Math.min(sy[0] ?? 0, sy[1] ?? 0, sy[2] ?? 0)));
      const y1 = Math.min(height - 1, Math.ceil(Math.max(sy[0] ?? 0, sy[1] ?? 0, sy[2] ?? 0)));
      if (x0 > x1 || y0 > y1) continue;

      const u0 = mesh.uvs[a * 2] ?? 0;
      const v0 = mesh.uvs[a * 2 + 1] ?? 0;
      const uvArea = Math.abs(
        ((mesh.uvs[b * 2] ?? 0) - u0) * ((mesh.uvs[c * 2 + 1] ?? 0) - v0) -
          ((mesh.uvs[c * 2] ?? 0) - u0) * ((mesh.uvs[b * 2 + 1] ?? 0) - v0),
      );
      const base = mipLevel(texture.levels, 0);
      const texelArea = uvArea * base.width * base.height;
      const pixelArea = Math.abs(denom) / 2;
      const lod = Math.min(
        texture.levels.length - 1,
        Math.max(0, 0.5 * Math.log2(Math.max(1e-6, texelArea) / Math.max(1e-6, pixelArea))),
      );
      const level = mipLevel(texture.levels, Math.round(lod));

      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 =
            (((sy[1] ?? 0) - (sy[2] ?? 0)) * (px - (sx[2] ?? 0)) +
              ((sx[2] ?? 0) - (sx[1] ?? 0)) * (py - (sy[2] ?? 0))) /
            denom;
          const w1 =
            (((sy[2] ?? 0) - (sy[0] ?? 0)) * (px - (sx[2] ?? 0)) +
              ((sx[0] ?? 0) - (sx[2] ?? 0)) * (py - (sy[2] ?? 0))) /
            denom;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const inv = w0 * (iz[0] ?? 0) + w1 * (iz[1] ?? 0) + w2 * (iz[2] ?? 0);
          const z = 1 / inv;
          const slot = y * width + x;
          if (z >= (zbuffer[slot] ?? 0)) continue;
          zbuffer[slot] = z;
          depth[slot] = z;
          const p0 = (w0 * (iz[0] ?? 0)) / inv;
          const p1 = (w1 * (iz[1] ?? 0)) / inv;
          const p2 = (w2 * (iz[2] ?? 0)) / inv;
          const u =
            p0 * (mesh.uvs[a * 2] ?? 0) + p1 * (mesh.uvs[b * 2] ?? 0) + p2 * (mesh.uvs[c * 2] ?? 0);
          const v =
            p0 * (mesh.uvs[a * 2 + 1] ?? 0) +
            p1 * (mesh.uvs[b * 2 + 1] ?? 0) +
            p2 * (mesh.uvs[c * 2 + 1] ?? 0);
          sampleLevel(level, u, v, colour);
          const nx =
            p0 * (normals[a * 3] ?? 0) + p1 * (normals[b * 3] ?? 0) + p2 * (normals[c * 3] ?? 0);
          const ny =
            p0 * (normals[a * 3 + 1] ?? 0) +
            p1 * (normals[b * 3 + 1] ?? 0) +
            p2 * (normals[c * 3 + 1] ?? 0);
          const nz =
            p0 * (normals[a * 3 + 2] ?? 0) +
            p1 * (normals[b * 3 + 2] ?? 0) +
            p2 * (normals[c * 3 + 2] ?? 0);
          const norm = Math.hypot(nx, ny, nz) || 1;
          let lambert = (nx * toLight[0] + ny * toLight[1] + nz * toLight[2]) / norm;
          const world3 = [
            p0 * (positions[a * 3] ?? 0) +
              p1 * (positions[b * 3] ?? 0) +
              p2 * (positions[c * 3] ?? 0),
            p0 * (positions[a * 3 + 1] ?? 0) +
              p1 * (positions[b * 3 + 1] ?? 0) +
              p2 * (positions[c * 3 + 1] ?? 0),
            p0 * (positions[a * 3 + 2] ?? 0) +
              p1 * (positions[b * 3 + 2] ?? 0) +
              p2 * (positions[c * 3 + 2] ?? 0),
          ];
          lambert = Math.max(0, lambert);
          const lit = litFraction(shadows, world3, 0.01 + 0.02 * z);
          const direct = lambert * (1 - lighting.shadowStrength * (1 - lit));
          const hemisphere = 0.7 + 0.3 * (ny / norm);
          const light = lighting.ambient * hemisphere + lighting.diffuse * direct;
          rgb[slot * 3] = Math.min(255, colour[0] * tint[0] * light);
          rgb[slot * 3 + 1] = Math.min(255, colour[1] * tint[1] * light);
          rgb[slot * 3 + 2] = Math.min(255, colour[2] * tint[2] * light);
        }
    }
  }
  return { rgb, depth };
}

export function groundMesh(options: {
  halfWidth: number;
  zNear: number;
  zFar: number;
  tile: number;
  texture: MipTexture;
  steps: number;
}): SceneMesh {
  const { halfWidth, zNear, zFar, tile, texture, steps } = options;
  const columns = steps;
  const rows = steps;
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array((columns + 1) * (rows + 1) * 2);
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= columns; c++) {
      const i = r * (columns + 1) + c;
      const x = -halfWidth + (2 * halfWidth * c) / columns;
      const z = zNear + ((zFar - zNear) * r) / rows;
      positions.set([x, 0, z], i * 3);
      normals.set([0, 1, 0], i * 3);
      uvs.set([x / tile, z / tile], i * 2);
    }
  const indices: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      const i = r * (columns + 1) + c;
      indices.push(i, i + columns + 1, i + 1, i + 1, i + columns + 1, i + columns + 2);
    }
  return {
    positions,
    normals,
    uvs,
    indices: Uint32Array.from(indices),
    texture,
    castsShadow: false,
  };
}
