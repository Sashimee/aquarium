export const FishState = {
  Cruise: 0,
  School: 1,
  Avoid: 2,
  Startle: 3,
  Rest: 4,
  Forage: 5,
  Gulp: 6,
  Graze: 7,
  Display: 8,
  Host: 9,
  Shelter: 10,
  Station: 11,
  Feed: 12,
} as const;
export type FishState = (typeof FishState)[keyof typeof FishState];

/** Per-fish record in a snapshot buffer, all float32. Quaternion is x, y, z, w. */
export const SnapshotField = {
  PosX: 0,
  PosY: 1,
  PosZ: 2,
  QuatX: 3,
  QuatY: 4,
  QuatZ: 5,
  QuatW: 6,
  Speed: 7,
  YawRate: 8,
  State: 9,
  /** Caudal thrust as a fraction of the maximum, 0 while coasting; drives the tail beat. */
  Thrust: 10,
} as const;
export const SNAPSHOT_STRIDE = 11;

export interface Snapshot {
  /** Bumped by every re-init; ticks restart at 0 within a new epoch. */
  readonly epoch: number;
  readonly tick: number;
  /** Simulation seconds at this tick. */
  readonly time: number;
  readonly data: Float32Array;
}

/** Blends two snapshots of the same fish set: lerp for scalars, shortest-arc nlerp for rotation. */
export function interpolateSnapshots(
  a: Float32Array,
  b: Float32Array,
  alpha: number,
  out: Float32Array,
): void {
  if (a.length !== b.length || out.length < a.length) {
    throw new RangeError(
      `snapshot sizes differ (a=${a.length}, b=${b.length}, out=${out.length}); re-init the fish set`,
    );
  }
  const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  for (let o = 0; o < a.length; o += SNAPSHOT_STRIDE) {
    for (let f = 0; f < 3; f++) {
      const av = a[o + f] ?? 0;
      out[o + f] = av + ((b[o + f] ?? 0) - av) * t;
    }
    const ax = a[o + 3] ?? 0;
    const ay = a[o + 4] ?? 0;
    const az = a[o + 5] ?? 0;
    const aw = a[o + 6] ?? 1;
    let bx = b[o + 3] ?? 0;
    let by = b[o + 4] ?? 0;
    let bz = b[o + 5] ?? 0;
    let bw = b[o + 6] ?? 1;
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    const qx = ax + (bx - ax) * t;
    const qy = ay + (by - ay) * t;
    const qz = az + (bz - az) * t;
    const qw = aw + (bw - aw) * t;
    const inv = 1 / Math.hypot(qx, qy, qz, qw);
    out[o + 3] = qx * inv;
    out[o + 4] = qy * inv;
    out[o + 5] = qz * inv;
    out[o + 6] = qw * inv;
    for (let f = 7; f < 9; f++) {
      const av = a[o + f] ?? 0;
      out[o + f] = av + ((b[o + f] ?? 0) - av) * t;
    }
    out[o + 9] = (t < 0.5 ? a[o + 9] : b[o + 9]) ?? 0;
    const thrust = a[o + 10] ?? 0;
    out[o + 10] = thrust + ((b[o + 10] ?? 0) - thrust) * t;
  }
}

/**
 * Keeps the two newest snapshots and renders slightly in the past (one step by default) so there
 * is always a pair to interpolate between. Times are caller-supplied, so this stays DOM-free.
 */
export class SnapshotInterpolator {
  private previous: Snapshot | null = null;
  private latest: Snapshot | null = null;
  private latestArrivalMs = 0;
  private readonly delaySeconds: number;

  constructor(delaySeconds: number) {
    this.delaySeconds = delaySeconds;
  }

  /**
   * Returns the snapshot that dropped out of the window, so its buffer can be recycled. A snapshot
   * from a newer epoch starts a fresh window and the old pair is dropped unreturned: the worker
   * cleared its buffer pool at re-init, so recycling them would gain nothing.
   */
  push(snapshot: Snapshot, arrivalMs: number): Snapshot | null {
    const latest = this.latest;
    if (latest !== null) {
      if (snapshot.epoch < latest.epoch) return snapshot;
      if (snapshot.epoch > latest.epoch) this.reset();
      else if (snapshot.tick <= latest.tick) return snapshot;
    }
    const evicted = this.previous;
    this.previous = this.latest;
    this.latest = snapshot;
    this.latestArrivalMs = arrivalMs;
    return evicted;
  }

  reset(): void {
    this.previous = null;
    this.latest = null;
    this.latestArrivalMs = 0;
  }

  renderTime(nowMs: number): number {
    if (this.latest === null) return 0;
    return this.latest.time + (nowMs - this.latestArrivalMs) / 1000 - this.delaySeconds;
  }

  /** Writes the interpolated state at `nowMs` into `out`; false until a snapshot has arrived. */
  sample(nowMs: number, out: Float32Array): boolean {
    const latest = this.latest;
    if (latest === null) return false;
    const previous = this.previous;
    if (previous === null || previous.data.length !== latest.data.length) {
      out.set(latest.data);
      return true;
    }
    const span = latest.time - previous.time;
    const alpha = span > 0 ? (this.renderTime(nowMs) - previous.time) / span : 1;
    interpolateSnapshots(previous.data, latest.data, alpha, out);
    return true;
  }
}
