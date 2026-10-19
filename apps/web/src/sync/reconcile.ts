import type { Fish, Tank } from '@aquarium/shared';

export interface FishDiff {
  /** On first sight of a tank every fish counts as added, dead ones included. */
  added: Fish[];
  /** Gone from the server: netted here or on another device. */
  removed: Fish[];
  /** Alive before, dead now. */
  died: Fish[];
  /** Still alive, with a different hunger, health, stage or size. */
  updated: Fish[];
}

export function diffFish(prev: readonly Fish[] | undefined, next: readonly Fish[]): FishDiff {
  const before = new Map((prev ?? []).map((f) => [f.id, f]));
  const after = new Map(next.map((f) => [f.id, f]));
  const diff: FishDiff = { added: [], removed: [], died: [], updated: [] };
  for (const fish of next) {
    const old = before.get(fish.id);
    if (!old) diff.added.push(fish);
    else if (old.status === 'alive' && fish.status === 'dead') diff.died.push(fish);
    else if (
      fish.status === 'alive' &&
      (old.hunger !== fish.hunger ||
        old.health !== fish.health ||
        old.stage !== fish.stage ||
        old.size !== fish.size)
    ) {
      diff.updated.push(fish);
    }
  }
  for (const fish of prev ?? []) {
    if (!after.has(fish.id)) diff.removed.push(fish);
  }
  return diff;
}

/**
 * A snapshot older than the one we hold would roll the tank back, which shows as fish popping
 * between states. The server's tick time only moves forward, so use it to refuse stale ones.
 */
export function isStaleSnapshot(held: Tank | undefined, incoming: Tank): boolean {
  if (!held || held.id !== incoming.id) return false;
  return Date.parse(incoming.lastTickAt) < Date.parse(held.lastTickAt);
}

/** Replaces the tank with the same id, or appends it. Never reorders existing tanks. */
export function upsertTank(tanks: readonly Tank[], tank: Tank): Tank[] {
  const index = tanks.findIndex((t) => t.id === tank.id);
  if (index === -1) return [...tanks, tank];
  return tanks.map((t, i) => (i === index ? tank : t));
}
