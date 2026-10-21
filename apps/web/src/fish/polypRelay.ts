import type { SimPolyps } from '@aquarium/sim';
import type { PolypSource } from '../scene/polyps';

type PolypListener = (extension: number, event: SimPolyps) => void;

/**
 * The tank's coral polyp extension, for any scene mounted now or later.
 *
 * While a sim world runs, its events are passed on. While none runs (before the fish are up, or a
 * tank with no swimming fish), the extension is the darkness, `1 - daylight`: where the sim's own
 * polyps settle, and where a new world starts them. The sim eases them over `NIGHT.polypTauS`;
 * without a world they follow the hood's announced level directly, which its hour-long ramps
 * already make gradual. A stopped world's value is never replayed.
 *
 * Events are renumbered into the relay's own epochs, since each sim worker counts its epochs from
 * zero and a listener drops anything older than what it has seen. A listener that joins late gets
 * the latest event at once, as the sim only speaks when the extension moves.
 */
export class PolypRelay implements PolypSource {
  private readonly listeners = new Set<PolypListener>();
  private latest: SimPolyps;
  private epoch = 0;
  private worldEpoch: number | null = null;
  /** The followed client's events from earlier epochs belong to a world that has stopped. */
  private firstWorldEpoch = Infinity;
  private idle = true;
  private idleTick = 0;
  private darkness: number;
  private unfollow: (() => void) | null = null;

  constructor(daylight: number) {
    this.darkness = darknessOf(daylight);
    this.latest = { type: 'polyps', epoch: 0, tick: 0, extension: this.darkness };
  }

  /** Listens to `client` instead of the previous one; its events count once `world` reports a world on it. */
  follow(client: PolypSource): void {
    this.unfollow?.();
    this.firstWorldEpoch = Infinity;
    this.worldEpoch = null;
    this.unfollow = client.onPolyps((extension, event) => this.fromWorld(extension, event));
  }

  /** A world began on the followed client at host epoch `epoch`, or (null) the world stopped. */
  world(epoch: number | null): void {
    this.firstWorldEpoch = epoch ?? Infinity;
    this.worldEpoch = null;
    if (epoch === null) this.goIdle();
  }

  setDaylight(level: number): void {
    this.darkness = darknessOf(level);
    if (this.idle) this.pass(this.darkness, ++this.idleTick);
  }

  onPolyps(listener: PolypListener): () => void {
    this.listeners.add(listener);
    listener(this.latest.extension, this.latest);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unfollow?.();
    this.unfollow = null;
    this.listeners.clear();
  }

  private fromWorld(extension: number, event: SimPolyps): void {
    if (event.epoch < this.firstWorldEpoch) return;
    if (event.epoch !== this.worldEpoch) {
      this.worldEpoch = event.epoch;
      this.epoch++;
      this.idle = false;
    }
    this.pass(extension, event.tick);
  }

  private goIdle(): void {
    this.idle = true;
    this.epoch++;
    this.idleTick = 0;
    this.pass(this.darkness, 0);
  }

  private pass(extension: number, tick: number): void {
    this.latest = { type: 'polyps', epoch: this.epoch, tick, extension };
    for (const listener of this.listeners) listener(extension, this.latest);
  }
}

function darknessOf(daylight: number): number {
  if (!(daylight >= 0 && daylight <= 1)) {
    throw new RangeError(`PolypRelay: daylight must be within [0, 1], got ${daylight}`);
  }
  return 1 - daylight;
}
