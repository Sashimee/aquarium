import type { AwaySummary, SpeciesSummary, Tank } from '@aquarium/shared';

export type SessionPhase = 'anonymous' | 'unverified' | 'loading' | 'ready' | 'offline';

export interface BaggedFish {
  fishId: string;
  name: string;
  releaseAtMs: number;
}

export interface SessionState {
  phase: SessionPhase;
  tanks: readonly Tank[];
  activeId: string | null;
  species: readonly SpeciesSummary[];
  /** Server-reported catch-up for tanks the player has not yet been told about. */
  awayByTank: Readonly<Record<string, AwaySummary>>;
  bagged: readonly BaggedFish[];
  /** A dead fish the player has asked to net and not yet confirmed. */
  pendingNet: string | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
}

export const INITIAL_STATE: SessionState = {
  phase: 'anonymous',
  tanks: [],
  activeId: null,
  species: [],
  awayByTank: {},
  bagged: [],
  pendingNet: null,
  busy: false,
  error: null,
  notice: null,
};
