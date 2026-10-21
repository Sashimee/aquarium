import { seedOf } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';

const PUBLIC_TANK = /^public:([0-9a-f]{1,8})$/;

/** A visitor's tank id already carries the seed in hex; an owned tank's seed is `seedOf('tank', id)`, as on the server. */
export function tankSeed(tankId: string): number {
  const visited = PUBLIC_TANK.exec(tankId);
  if (visited?.[1]) return Number.parseInt(visited[1], 16);
  return seedOf('tank', tankId);
}

export const NO_TANK_SEED = 0;

/**
 * Tracks the seed of the active tank for the room's weather. Created before the engine exists so
 * no `tank:loaded` is missed; a tank that loads while an earlier seed is still being derived wins.
 */
export class RoomSeedFeed {
  private seed = NO_TANK_SEED;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[];

  constructor(interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId }) => this.load(tankId)),
      interaction.on('tank:unloaded', () => this.set(NO_TANK_SEED)),
      interaction.on('tank:none', () => this.set(NO_TANK_SEED)),
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
    this.set(tankSeed(tankId));
  }

  private set(seed: number): void {
    if (seed === this.seed) return;
    this.seed = seed;
    for (const listener of [...this.listeners]) listener();
  }
}
