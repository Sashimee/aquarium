import type { CareEvent, Fish, Tank } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import type { PlaybackCommand } from './replayPlayback';

type Bus = Pick<EventBus<InteractionEvents>, 'emit'>;

/** A fish that died during the absence was swimming when it began. */
function aliveAgain(fish: Fish): Fish {
  return fish.status === 'alive'
    ? fish
    : { ...fish, status: 'alive', diedAt: null, cause: null, health: Math.max(fish.health, 0.5) };
}

/**
 * The fish on screen after the first `shown` events: those the replay has not reached yet are as
 * they were when the absence began, with newborns absent and the fish that die still alive. Fish no
 * longer in the tank (netted since) cannot be shown.
 */
export function rosterAt(
  live: readonly Fish[],
  events: readonly CareEvent[],
  shown: number,
): Fish[] {
  const byId = new Map(live.map((f) => [f.id, f]));
  const bornInReplay = new Set<string>();
  const diesInReplay = new Set<string>();
  for (const e of events) {
    if (e.kind === 'born') bornInReplay.add(e.payload.fishId);
    if (e.kind === 'death') diesInReplay.add(e.payload.fishId);
  }
  const present = new Map<string, Fish>();
  for (const f of live) {
    if (bornInReplay.has(f.id)) continue;
    present.set(f.id, diesInReplay.has(f.id) ? aliveAgain(f) : f);
  }
  for (const e of events.slice(0, shown)) {
    if (e.kind === 'born') {
      const fish = byId.get(e.payload.fishId);
      if (fish) present.set(fish.id, diesInReplay.has(fish.id) ? aliveAgain(fish) : fish);
    } else if (e.kind === 'death') {
      const fish = byId.get(e.payload.fishId);
      if (fish) present.set(fish.id, fish);
    }
  }
  return live.filter((f) => present.has(f.id)).map((f) => present.get(f.id) as Fish);
}

export interface ReplayDirectorOptions {
  interaction: Bus;
  /** The tank as it is now; read at the moment of each command, so a restore is never stale. */
  getTank(): Tank;
  events: readonly CareEvent[];
}

export interface ReplayDirector {
  run(commands: readonly PlaybackCommand[]): void;
}

export function createReplayDirector(options: ReplayDirectorOptions): ReplayDirector {
  const { interaction, events } = options;
  const tankId = options.getTank().id;

  const loadRoster = (fish: readonly Fish[]): void => {
    const tank = options.getTank();
    interaction.emit('tank:loaded', {
      tankId: tank.id,
      biome: tank.biome,
      fish,
      decorLayout: tank.decorLayout,
      decorEdited: tank.decorEdited,
      backgroundId: tank.backgroundId,
    });
  };

  const apply = (index: number): void => {
    const event = events[index];
    const tank = options.getTank();
    if (!event) return;
    if (event.kind === 'born') {
      const fish = tank.fish.find((f) => f.id === event.payload.fishId);
      if (fish) {
        interaction.emit('tank:fish-added', {
          tankId: tank.id,
          fish: rosterAt(tank.fish, events, index + 1).find((f) => f.id === fish.id) ?? fish,
          acclimate: false,
        });
      }
    } else if (event.kind === 'death') {
      const fish = tank.fish.find((f) => f.id === event.payload.fishId);
      if (fish?.status === 'dead') interaction.emit('tank:fish-died', { tankId: tank.id, fish });
    }
  };

  return {
    run(commands) {
      for (const command of commands) {
        switch (command.type) {
          case 'reset-roster':
            if (options.getTank().id !== tankId) break;
            loadRoster(rosterAt(options.getTank().fish, events, command.shown));
            break;
          case 'apply':
            if (options.getTank().id !== tankId) break;
            apply(command.index);
            break;
          case 'time-scale':
            interaction.emit('replay:time-scale', { scale: command.scale });
            break;
          case 'restore':
            // The player switched tanks meanwhile; the new tank has loaded itself.
            if (options.getTank().id !== tankId) break;
            loadRoster(options.getTank().fish);
            break;
        }
      }
    },
  };
}
