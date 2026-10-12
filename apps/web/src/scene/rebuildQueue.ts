/**
 * Serialises rebuilds so the latest request always wins. Each request bumps a generation; a build
 * that finishes under an older generation is told it is stale and must free what it made, so a
 * quick A -> B -> A never leaves B's result on screen.
 */
export class RebuildQueue<K> {
  private requested: K | null = null;
  private shown: K | null = null;
  private generation = 0;
  private pending: K | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly same: (a: K, b: K) => boolean,
    private readonly build: (key: K, isStale: () => boolean) => Promise<boolean>,
    private readonly onError: (cause: unknown) => void,
  ) {}

  get shownKey(): K | null {
    return this.shown;
  }

  adopt(key: K): void {
    this.requested = key;
    this.shown = key;
  }

  request(key: K): void {
    if (this.stopped) return;
    if (this.requested !== null && this.same(this.requested, key)) return;
    this.requested = key;
    this.generation++;
    this.pending = key;
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }

  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending = null;
    await this.settled();
  }

  private async drain(): Promise<void> {
    while (this.pending !== null && !this.stopped) {
      const key = this.pending;
      this.pending = null;
      if (this.shown !== null && this.same(this.shown, key)) continue;
      const generation = this.generation;
      const isStale = () => this.stopped || generation !== this.generation;
      try {
        if (await this.build(key, isStale)) this.shown = key;
      } catch (cause) {
        if (!isStale()) this.requested = this.shown;
        this.onError(cause);
      }
    }
  }
}
