import type { FishPhase } from './roster';

/**
 * A rebuilt world normally posts its first frame within a few hundred milliseconds. Past this, it
 * is taken as stuck (an init that never answers, or a worker that never posts) and held fish stop
 * waiting, so they hide like every other swimming fish without a frame rather than hang frozen.
 */
export const HOLD_TIMEOUT_S = 5;

export interface HoldCandidate {
  readonly id: string;
  readonly shown: boolean;
  readonly phase: FishPhase;
  readonly bagged: boolean;
  readonly scripted: boolean;
}

/** Where a fish is in the frame the sim stream gave this render, if it gave one. */
export type FramePresence = 'no-frame' | 'present' | 'missing';

/**
 * - `free`: not held; the fish follows the usual rule.
 * - `wait`: stays at the pose it was last drawn in.
 * - `join`: was held and is in this frame; blends from its last pose into the sim's.
 */
export type HeldStep = 'free' | 'wait' | 'join';

/**
 * Swimming fish on screen when the running world is dropped after a failed add or remove. They wait
 * where they are for the rebuilt world rather than vanish until its first frame, and then glide into
 * it. Everything that ends the wait is a release: that frame, a fish's death or departure, the world
 * being stopped or swapped, the rebuild failing, or `HOLD_TIMEOUT_S` passing.
 */
export class HeldFish {
  private readonly ids = new Set<string>();
  private deadlineS = Infinity;

  /** Holds exactly the shown swimming fish of `fish` that no bag or death script is posing. */
  hold(fish: Iterable<HoldCandidate>, nowS: number): void {
    this.ids.clear();
    for (const f of fish) {
      if (f.shown && f.phase === 'swimming' && !f.bagged && !f.scripted) this.ids.add(f.id);
    }
    this.deadlineS = nowS + HOLD_TIMEOUT_S;
  }

  release(id: string): void {
    this.ids.delete(id);
  }

  releaseAll(): void {
    this.ids.clear();
  }

  /** What fish `id` does this render; a held fish found in, or missing from, a frame is let go. */
  step(id: string, nowS: number, presence: FramePresence): HeldStep {
    if (!this.ids.has(id)) return 'free';
    if (presence === 'no-frame') {
      if (nowS < this.deadlineS) return 'wait';
      this.ids.clear();
      return 'free';
    }
    this.ids.delete(id);
    return presence === 'present' ? 'join' : 'free';
  }
}
