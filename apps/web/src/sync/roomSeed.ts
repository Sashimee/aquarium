import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';

const PUBLIC_TANK = /^public:([0-9a-f]{1,8})$/;

/**
 * The seed the server derives for a tank (`seedOf('tank', id)` in `apps/api/src/public.ts`: the
 * first four bytes of SHA-256 of `tank:<id>`). A visitor's tank id already carries the seed in hex.
 * The API keeps that function private, so `roomSeed.test.ts` pins this one against it.
 */
export async function tankSeed(tankId: string): Promise<number> {
  const visited = PUBLIC_TANK.exec(tankId);
  if (visited?.[1]) return Number.parseInt(visited[1], 16);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tank:${tankId}`));
  return new DataView(digest).getUint32(0);
}

export const NO_TANK_SEED = 0;

/**
 * Tracks the seed of the active tank for the room's weather. Created before the engine exists so
 * no `tank:loaded` is missed; a tank that loads while an earlier seed is still being derived wins.
 */
export class RoomSeedFeed {
  private seed = NO_TANK_SEED;
  private latest: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[];

  constructor(interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId }) => this.load(tankId)),
      interaction.on('tank:unloaded', () => this.set(null, NO_TANK_SEED)),
      interaction.on('tank:none', () => this.set(null, NO_TANK_SEED)),
    ];
  }

  readonly current = (): number => this.seed;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.listeners.clear();
  }

  private load(tankId: string): void {
    this.latest = tankId;
    void tankSeed(tankId).then((seed) => {
      if (this.latest === tankId) this.set(tankId, seed);
    });
  }

  private set(tankId: string | null, seed: number): void {
    this.latest = tankId;
    if (seed === this.seed) return;
    this.seed = seed;
    for (const listener of [...this.listeners]) listener();
  }
}
