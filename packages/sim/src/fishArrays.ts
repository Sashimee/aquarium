export type FishArray =
  Float64Array | Int32Array | Int8Array | Uint8Array | Uint16Array | Uint32Array;

/**
 * One change to the fish set: a fish joins at index `count`, or the fish at `removed` leaves and
 * every later fish moves down one index. Every per-fish array and every array holding fish
 * indices goes through it, so all of them agree on the new numbering.
 */
export class FishResize {
  /** Fish before the change. */
  readonly count: number;
  /** Index of the fish leaving, or -1 when one joins. */
  readonly removed: number;

  private constructor(count: number, removed: number) {
    this.count = count;
    this.removed = removed;
  }

  static join(count: number): FishResize {
    return new FishResize(count, -1);
  }

  static leave(count: number, removed: number): FishResize {
    if (!Number.isInteger(removed) || removed < 0 || removed >= count) {
      throw new RangeError(`no fish at index ${removed} of ${count}`);
    }
    return new FishResize(count, removed);
  }

  /** Fish after the change. */
  get next(): number {
    return this.removed < 0 ? this.count + 1 : this.count - 1;
  }

  /** `a` holds `width` values per fish; returns it resized, a joining fish's values set to `fill`. */
  array<T extends FishArray>(a: T, width = 1, fill = 0): T {
    if (a.length !== this.count * width) {
      throw new RangeError(
        `per-fish array holds ${a.length} values, expected ${this.count} fish × ${width}`,
      );
    }
    const out = new (a.constructor as new (length: number) => T)(this.next * width);
    const r = this.removed;
    if (r < 0) {
      out.set(a);
      out.fill(fill, a.length);
    } else {
      out.set(a.subarray(0, r * width));
      out.set(a.subarray((r + 1) * width), r * width);
    }
    return out;
  }

  /** Where the fish at old index `j` now is: -1 for the one that left, negatives kept as they are. */
  index(j: number): number {
    const r = this.removed;
    if (r < 0 || j < r) return j;
    return j === r ? -1 : j - 1;
  }

  /** Renumbers every fish index held in `a` in place. */
  remap(a: Int32Array): void {
    if (this.removed < 0) return;
    for (let m = 0; m < a.length; m++) a[m] = this.index(a[m] ?? -1);
  }
}
