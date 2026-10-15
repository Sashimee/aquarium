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

/**
 * The rotation taking the body frame to the orthonormal basis whose +Y is `up` and +Z is
 * `forward` (left = up × forward); `up` must be perpendicular to `forward`.
 */
export function quatFromBasis(
  forward: Readonly<Vec3>,
  up: Readonly<Vec3>,
  out: Float32Array | Float64Array,
  o: number,
): void {
  const [m02, m12, m22] = forward;
  const [m01, m11, m21] = up;
  const m00 = m11 * m22 - m21 * m12;
  const m10 = m21 * m02 - m01 * m22;
  const m20 = m01 * m12 - m11 * m02;
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const inv = 1 / Math.hypot(x, y, z, w);
  out[o] = x * inv;
  out[o + 1] = y * inv;
  out[o + 2] = z * inv;
  out[o + 3] = w * inv;
}
