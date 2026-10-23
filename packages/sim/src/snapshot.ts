import { clamp } from './math.ts';

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
  /** A walker stepping over a surface. */
  Walk: 13,
  /** A walker standing still, picking at the surface or at food. */
  Pick: 14,
  /** Reserved for the cleaner shrimp's client dance; not emitted yet. */
  Dance: 15,
  /** A walker's tail-flip escape. */
  TailFlip: 16,
  /** A walker off any surface, sinking until it lands. */
  Fall: 17,
  /** A parent at its clutch, fanning the eggs with its pectorals or mouthing them. */
  Tend: 18,
  /** A client holding still at a cleaning station, fins spread, for the cleaner to inspect. */
  Pose: 19,
  /** A cleaner darting to and picking at a posing client. */
  Clean: 20,
  /** An amphibious fish out of the water: climbing onto a bank, perched on it or going back. */
  Emerse: 21,
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
  /**
   * Walkers: leg cycle phase in [0, 1), advancing one cycle per stride; 0 for swimmers. The body's
   * up axis (the quaternion's +Y) is the surface normal while attached.
   */
  LegPhase: 11,
  /** Walkers: tail-flip progress from 0 at onset to 1 at its end; 0 outside a flip. */
  Flip: 12,
  /** Walkers: 1 while standing on a surface, 0 while flipping or falling; 0 for swimmers. */
  Attached: 13,
  /** 0 to 1: fins spread in display (to a rival or a mirror); 0 at rest. */
  Display: 14,
  /** 0 to 1: gill covers raised in display; 0 at rest. */
  GillFlare: 15,
  /** 0 to 1: pectoral fanning over a clutch, eased in and out; 0 away from the eggs. */
  Fan: 16,
} as const;
export const SNAPSHOT_STRIDE = 17;

export interface Snapshot {
  /**
   * Bumped by every re-init and by every fish added or removed (see `SimLayout`); ticks restart at
   * 0 only after a re-init.
   */
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
    const phase = a[o + 11] ?? 0;
    let step = (b[o + 11] ?? 0) - phase;
    step -= Math.round(step);
    const legs = phase + step * t;
    out[o + 11] = legs - Math.floor(legs);
    const flip = a[o + 12] ?? 0;
    const flipB = b[o + 12] ?? 0;
    // A new flip starting between the two snapshots would otherwise rewind through the old one.
    out[o + 12] = flipB >= flip ? flip + (flipB - flip) * t : t < 0.5 ? flip : flipB;
    out[o + 13] = (t < 0.5 ? a[o + 13] : b[o + 13]) ?? 0;
    for (let f = SnapshotField.Display; f < SNAPSHOT_STRIDE; f++) {
      const av = a[o + f] ?? 0;
      out[o + f] = av + ((b[o + f] ?? 0) - av) * t;
    }
  }
}

/** Clock-error horizon: the render clock closes its lag behind the newest snapshot over this. */
const SLEW_SECONDS = 0.5;
/** Largest fraction by which the render clock may run fast or slow while it slews. */
const MAX_SLEW = 0.2;
/** A render clock this far behind (a stalled tab, a long worker pause) jumps instead of slewing. */
const RESYNC_SECONDS = 0.25;
const ON_TIME_SECONDS = 1e-6;

/**
 * Keeps the two newest snapshots and renders slightly in the past (one step by default) so there
 * is always a pair to interpolate between. Times are caller-supplied, so this stays DOM-free.
 *
 * Render time runs on its own clock at wall-clock rate, nudged faster or slower toward the newest
 * snapshot's time minus the delay. Re-basing it on each arrival would make it step backwards after
 * an early post and leap after a late one, and every fish would hitch.
 */
export class SnapshotInterpolator {
  private previous: Snapshot | null = null;
  private latest: Snapshot | null = null;
  private anchorMs = 0;
  private anchorTime = 0;
  private rate = 1;
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
    const target = snapshot.time - this.delaySeconds;
    if (this.latest === null || this.previous === null) {
      // Nothing has been interpolated yet, so the clock can still be set outright.
      this.anchor(Math.max(arrivalMs, this.anchorMs), target, 1);
    } else {
      const at = Math.max(arrivalMs, this.anchorMs);
      const now = this.renderTime(at);
      const lag = target - now;
      // Slewing would leave the clock before the snapshot about to become `previous`, where the
      // fraction clamps to 0 and fish step unsmoothed until it catches up. Jitter under half a
      // delay is worth that brief hold to stay smooth; a stall's late or bunched arrivals are not.
      const resync = Math.min(RESYNC_SECONDS, this.delaySeconds / 2);
      if (lag > resync || Math.abs(lag) < ON_TIME_SECONDS) this.anchor(at, target, 1);
      else this.anchor(at, now, 1 + clamp(lag / SLEW_SECONDS, -MAX_SLEW, MAX_SLEW));
    }
    const evicted = this.previous;
    this.previous = this.latest;
    this.latest = snapshot;
    return evicted;
  }

  /**
   * Swaps the window for the same frames read into a new layout, keeping the clock, so a fish added
   * or removed doesn't move the others in time. Returns the replaced snapshots for recycling.
   */
  relayout(previous: Snapshot | null, latest: Snapshot): Snapshot[] {
    const old = this.latest;
    if (old === null || latest.time !== old.time || previous?.time !== this.previous?.time) {
      throw new RangeError('relayout must carry the frames of the current window');
    }
    const replaced = this.previous === null ? [old] : [this.previous, old];
    this.previous = previous;
    this.latest = latest;
    return replaced;
  }

  reset(): void {
    this.previous = null;
    this.latest = null;
    this.anchorMs = 0;
    this.anchorTime = 0;
    this.rate = 1;
  }

  /**
   * Never decreases as `nowMs` grows. It stops at the newest snapshot's time, since rendering past
   * it shows the same frame, which also bounds how far ahead the clock can get before the next one.
   */
  renderTime(nowMs: number): number {
    const latest = this.latest;
    if (latest === null) return 0;
    const elapsed = Math.max(0, nowMs - this.anchorMs) / 1000;
    return Math.min(this.anchorTime + elapsed * this.rate, latest.time);
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

  private anchor(atMs: number, time: number, rate: number): void {
    this.anchorMs = atMs;
    this.anchorTime = time;
    this.rate = rate;
  }
}
