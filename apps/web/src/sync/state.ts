import type { AwaySummary, SpeciesSummary, Tank } from '@aquarium/shared';

export type SessionPhase = 'anonymous' | 'unverified' | 'loading' | 'ready' | 'offline';

export interface BaggedFish {
  fishId: string;
  name: string;
  releaseAtMs: number;
}

export interface BirthNotice {
  tankId: string;
  fishIds: readonly string[];
  text: string;
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
  /** Pearls the server reports; null until the first read. */
  balance: number | null;
  /** Item refs already bought, as far as the recent ledger shows. */
  owned: readonly string[];
  /** Pearls that arrived since the player last looked; shown once, then dismissed. */
  earned: number | null;
  /** The last paid request was refused for too few Pearls. */
  pearlsRefused: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  /** Fry born while the player watches; tapping it focuses the brood. */
  birth: BirthNotice | null;
}

export const INITIAL_STATE: SessionState = {
  phase: 'anonymous',
  tanks: [],
  activeId: null,
  species: [],
  awayByTank: {},
  bagged: [],
  pendingNet: null,
  balance: null,
  owned: [],
  earned: null,
  pearlsRefused: false,
  busy: false,
  error: null,
  notice: null,
  birth: null,
};
