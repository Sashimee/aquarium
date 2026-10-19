import { SNAPSHOT_STRIDE, SnapshotInterpolator, type Snapshot } from '@aquarium/sim';

export interface StreamLayout {
  readonly epoch: number;
  readonly ids: readonly string[];
  /** Float offset of each fish's record in this layout's snapshots and in `frame`. */
  readonly offsets: ReadonlyMap<string, number>;
  /** The interpolated pose of every fish, rewritten by `sample`. */
  readonly frame: Float32Array;
}

interface Announced {
  readonly ids: readonly string[];
  /** The running world changed, so the held window carries over; false for a new world. */
  readonly carry: boolean;
}

function layoutOf(epoch: number, ids: readonly string[]): StreamLayout {
  return {
    epoch,
    ids,
    offsets: new Map(ids.map((id, i) => [id, i * SNAPSHOT_STRIDE])),
    frame: new Float32Array(ids.length * SNAPSHOT_STRIDE),
  };
}

/**
 * `from`, taken in `old`, rewritten into `next` by fish id. A fish `old` did not have takes its
 * record from `fresh`, the first snapshot of `next`.
 */
function remap(from: Snapshot, old: StreamLayout, next: StreamLayout, fresh: Snapshot): Snapshot {
  const data = new Float32Array(next.ids.length * SNAPSHOT_STRIDE);
  next.ids.forEach((id, i) => {
    const kept = old.offsets.get(id);
    const source = kept === undefined ? fresh.data : from.data;
    const start = kept ?? i * SNAPSHOT_STRIDE;
    data.set(source.subarray(start, start + SNAPSHOT_STRIDE), i * SNAPSHOT_STRIDE);
  });
  return { epoch: next.epoch, tick: from.tick, time: from.time, data };
}

/**
 * The sim's snapshots, each read in the layout of the epoch it was taken in. A world's first layout
 * comes with `ready`; every fish added or removed brings the next one in a `layout` event, which
 * arrives before that epoch's first snapshot. A snapshot from an epoch that is neither current nor
 * announced is never read, so a stale record can't land on another fish.
 *
 * On a change to the running world the interpolation window is rewritten into the new layout by
 * fish id, keeping its times and the render clock, so every fish that stayed moves on without a jump.
 */
export class SimStream {
  private readonly interpolator: SnapshotInterpolator;
  private readonly announced = new Map<number, Announced>();
  private current: StreamLayout | null = null;
  private started = false;
  private previous: Snapshot | null = null;
  private latest: Snapshot | null = null;

  constructor(
    delaySeconds: number,
    private readonly recycle: (snapshot: Snapshot) => void,
  ) {
    this.interpolator = new SnapshotInterpolator(delaySeconds);
  }

  get layout(): StreamLayout | null {
    return this.current;
  }

  /** A new world from `init`: nothing of the previous one carries over. */
  begin(epoch: number, ids: readonly string[]): void {
    this.started = true;
    this.announced.set(epoch, { ids, carry: false });
  }

  /**
   * The running world gained or lost a fish. Ignored after `reset` until the next `begin`, so a
   * change that was in flight when the world was dropped can't revive it.
   */
  change(epoch: number, ids: readonly string[]): void {
    if (!this.started || (this.current !== null && epoch <= this.current.epoch)) return;
    this.announced.set(epoch, { ids, carry: true });
  }

  /** Forgets the world; nothing shows until a `begin` and its first snapshot. */
  reset(): void {
    this.started = false;
    this.announced.clear();
    this.current = null;
    this.interpolator.reset();
    this.previous = null;
    this.latest = null;
  }

  push(snapshot: Snapshot, arrivalMs: number): void {
    const current = this.current;
    if (current !== null && snapshot.epoch === current.epoch) {
      this.accept(snapshot, arrivalMs);
      return;
    }
    const next = this.announced.get(snapshot.epoch);
    if (next === undefined) {
      this.recycle(snapshot);
      return;
    }
    for (const epoch of this.announced.keys()) {
      if (epoch <= snapshot.epoch) this.announced.delete(epoch);
    }
    const layout = layoutOf(snapshot.epoch, next.ids);
    if (snapshot.data.length !== layout.frame.length) {
      this.recycle(snapshot);
      throw new RangeError(
        `sim snapshot of epoch ${snapshot.epoch} holds ${snapshot.data.length} floats, but its ` +
          `layout of ${next.ids.length} fish needs ${layout.frame.length}`,
      );
    }
    const previous = this.previous;
    const latest = this.latest;
    this.current = layout;
    if (next.carry && current !== null && latest !== null) {
      this.previous = previous === null ? null : remap(previous, current, layout, snapshot);
      this.latest = remap(latest, current, layout, snapshot);
      for (const old of this.interpolator.relayout(this.previous, this.latest)) this.recycle(old);
    } else {
      this.interpolator.reset();
      this.previous = null;
      this.latest = null;
    }
    this.accept(snapshot, arrivalMs);
  }

  /** The interpolated frame at `nowMs` in the current layout, or null before its first snapshot. */
  sample(nowMs: number): Float32Array | null {
    const layout = this.current;
    return layout !== null && this.interpolator.sample(nowMs, layout.frame) ? layout.frame : null;
  }

  private accept(snapshot: Snapshot, arrivalMs: number): void {
    const evicted = this.interpolator.push(snapshot, arrivalMs);
    if (evicted === snapshot) {
      this.recycle(snapshot);
      return;
    }
    this.previous = this.latest;
    this.latest = snapshot;
    if (evicted !== null) this.recycle(evicted);
  }
}
