import type { SimPolyps } from '@aquarium/sim';
import type { PolypSource } from '../scene/polyps';

type PolypListener = (extension: number, event: SimPolyps) => void;

/**
 * The polyp extension of whichever sim client the fish run on, for any scene mounted now or later.
 * The sim only speaks when the extension moves, so a listener that joins late gets the latest
 * event at once. Each sim worker numbers its epochs from zero, so a replacement client's epochs
 * are moved past every one already passed on; otherwise a listener that drops older epochs would
 * drop everything the new worker says.
 */
export class PolypRelay implements PolypSource {
  private readonly listeners = new Set<PolypListener>();
  private latest: SimPolyps | null = null;
  private epochBase = 0;
  private unfollow: (() => void) | null = null;

  /** Passes on `client`'s events instead of the previous client's. */
  follow(client: PolypSource): void {
    this.unfollow?.();
    if (this.latest !== null) this.epochBase = this.latest.epoch + 1;
    const base = this.epochBase;
    this.unfollow = client.onPolyps((extension, event) => {
      const passed: SimPolyps = {
        type: 'polyps',
        epoch: event.epoch + base,
        tick: event.tick,
        extension,
      };
      this.latest = passed;
      for (const listener of this.listeners) listener(extension, passed);
    });
  }

  onPolyps(listener: PolypListener): () => void {
    this.listeners.add(listener);
    if (this.latest !== null) listener(this.latest.extension, this.latest);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unfollow?.();
    this.unfollow = null;
    this.listeners.clear();
  }
}
