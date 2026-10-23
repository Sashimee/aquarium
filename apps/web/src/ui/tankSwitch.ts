import type { Biome, CreatableBiome } from '@aquarium/shared';
import type { SessionState } from '../sync/state';

export type SwitchPlan =
  | { kind: 'none' }
  | { kind: 'demo'; biome: Biome }
  | { kind: 'select'; tankId: string }
  | { kind: 'create'; biome: CreatableBiome };

type SwitchState = Pick<SessionState, 'phase' | 'tanks' | 'activeId'>;

function activeBiome(state: SwitchState): Biome | null {
  if (state.phase !== 'ready') return null;
  return state.tanks.find((t) => t.id === state.activeId)?.biome ?? null;
}

/** The biome on screen: the active saved tank's, or the demo tank's. */
export function shownBiome(state: SwitchState, demo: Biome): Biome {
  return activeBiome(state) ?? demo;
}

/** A signed-in player whose tanks are still loading has nothing to switch yet. */
export function canSwitch(state: Pick<SessionState, 'phase' | 'busy'>): boolean {
  return state.phase !== 'loading' && !state.busy;
}

/** What choosing `target` does: retarget the demo, pick one of the player's tanks, or start a new one. */
export function planSwitch(state: SwitchState, demo: Biome, target: CreatableBiome): SwitchPlan {
  if (state.phase !== 'ready') {
    return target === demo ? { kind: 'none' } : { kind: 'demo', biome: target };
  }
  if (activeBiome(state) === target) return { kind: 'none' };
  const existing = state.tanks.find((t) => t.biome === target);
  return existing ? { kind: 'select', tankId: existing.id } : { kind: 'create', biome: target };
}
