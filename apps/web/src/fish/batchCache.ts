/**
 * The loaded batches, one per key. Each key loads at most once at a time and is never retried after
 * a failure. A load that finishes once its key is no longer wanted, or after `dispose()`, is
 * released at once instead of kept, and every kept batch is released exactly once.
 */
export class BatchCache<V> {
  private readonly ready = new Map<string, V>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly unavailable = new Set<string>();
  private disposed = false;

  constructor(
    private readonly release: (batch: V) => void,
    private readonly wanted: () => ReadonlySet<string>,
  ) {}

  get(key: string): V | undefined {
    return this.ready.get(key);
  }

  values(): Iterable<V> {
    return this.ready.values();
  }

  /** Loads `key` unless it is loaded, loading or failed; `load` gives null when it cannot. */
  load(key: string, load: () => Promise<V | null>): Promise<void> {
    if (this.disposed || this.ready.has(key) || this.unavailable.has(key)) return Promise.resolve();
    let pending = this.loading.get(key);
    if (pending === undefined) {
      pending = this.settle(key, load).finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  /** Releases every batch whose key is no longer wanted; it loads afresh if wanted again. */
  evictUnwanted(): void {
    const wanted = this.wanted();
    for (const [key, batch] of this.ready) {
      if (wanted.has(key)) continue;
      this.ready.delete(key);
      this.release(batch);
    }
  }

  dispose(): void {
    this.disposed = true;
    const batches = [...this.ready.values()];
    this.ready.clear();
    for (const batch of batches) this.release(batch);
  }

  private async settle(key: string, load: () => Promise<V | null>): Promise<void> {
    const batch = await load();
    if (batch === null) {
      this.unavailable.add(key);
      return;
    }
    if (this.disposed || !this.wanted().has(key)) {
      this.release(batch);
      return;
    }
    this.ready.set(key, batch);
  }
}
