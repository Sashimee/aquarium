export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r < -Math.PI) r += TAU;
  return r;
}

/**
 * Body frame: +Z forward, +Y up, so the fish's left is +X. Yaw turns +Z towards +X (a left
 * turn), positive pitch raises the nose, positive roll lowers the right (−X) side.
 */
export function quatFromYawPitchRoll(
  yaw: number,
  pitch: number,
  roll: number,
  out: Float32Array | Float64Array,
  o: number,
): void {
  const sy = Math.sin(yaw * 0.5);
  const cy = Math.cos(yaw * 0.5);
  const sp = Math.sin(-pitch * 0.5);
  const cp = Math.cos(-pitch * 0.5);
  const sr = Math.sin(roll * 0.5);
  const cr = Math.cos(roll * 0.5);
  const x1 = cy * sp;
  const y1 = sy * cp;
  const z1 = -sy * sp;
  const w1 = cy * cp;
  out[o] = x1 * cr + y1 * sr;
  out[o + 1] = y1 * cr - x1 * sr;
  out[o + 2] = w1 * sr + z1 * cr;
  out[o + 3] = w1 * cr - z1 * sr;
}

export function rotateByQuat(q: ArrayLike<number>, qo: number, v: Readonly<Vec3>): Vec3 {
  const qx = q[qo] ?? 0;
  const qy = q[qo + 1] ?? 0;
  const qz = q[qo + 2] ?? 0;
  const qw = q[qo + 3] ?? 1;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}
