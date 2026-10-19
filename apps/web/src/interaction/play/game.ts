export const ROUND_S = 20;
export const PINCHES_PER_ROUND = 5;
/** After the last pinch the fish get this long to finish eating before the round is scored. */
export const LAST_PINCH_GRACE_S = 6;
const TARGET_POINTS_PER_PORTION = 100;
const RIVAL_PENALTY_PER_PORTION = 30;
const BEST_KEY = 'aquarium.feeding-game.best';

export interface GameFish {
  readonly id: string;
  readonly name: string;
  readonly boldness: number;
  /** Eats flakes and swims high enough to reach them floating, so it can win. */
  readonly eligible: boolean;
}

export type GameView =
  | { readonly phase: 'idle'; readonly best: number }
  | { readonly phase: 'unavailable'; readonly reason: string; readonly best: number }
  | {
      readonly phase: 'running';
      readonly targetId: string;
      readonly targetName: string;
      /** Rounded up to whole seconds for display: the view is reused, so this can lag by up to 1 s. */
      readonly timeLeftS: number;
      readonly pinchesLeft: number;
      readonly score: number;
      readonly best: number;
    }
  | {
      readonly phase: 'done';
      readonly targetName: string;
      readonly score: number;
      readonly best: number;
      readonly newBest: boolean;
      readonly targetAte: boolean;
    };

export interface BestStore {
  read(): number;
  write(score: number): void;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Keeps the best score in local storage; a store that refuses (private mode, quota) is reported and the best lasts the session. */
export function localBest(
  storage: KeyValueStorage | null,
  report: (message: string, cause: unknown) => void,
): BestStore {
  let session = 0;
  return {
    read() {
      if (!storage) return session;
      try {
        const stored = Number(storage.getItem(BEST_KEY));
        if (Number.isFinite(stored) && stored > 0) session = Math.max(session, stored);
      } catch (cause) {
        report('The feeding game could not read its best score', cause);
      }
      return session;
    },
    write(score) {
      session = Math.max(session, score);
      if (!storage) return;
      try {
        storage.setItem(BEST_KEY, String(session));
      } catch (cause) {
        report('The feeding game could not save its best score', cause);
      }
    },
  };
}

type Round = {
  target: GameFish;
  timeLeftS: number;
  pinchesLeft: number;
  graceS: number | null;
  targetPortion: number;
  rivalPortion: number;
};

/** One short round: drop up to five pinches so the shy fish eats before the bold ones do. */
export class FeedingGame {
  private round: Round | null = null;
  private last: GameView;
  private best: number;
  private readonly dropped = new Set<number>();

  constructor(
    private readonly store: BestStore,
    private readonly random: () => number = Math.random,
  ) {
    this.best = store.read();
    this.last = { phase: 'idle', best: this.best };
  }

  get view(): GameView {
    return this.last;
  }

  get running(): boolean {
    return this.round !== null;
  }

  start(fish: readonly GameFish[]): GameView {
    const best = (this.best = this.store.read());
    this.round = null;
    this.dropped.clear();
    if (fish.length < 2) {
      return (this.last = {
        phase: 'unavailable',
        reason: 'You need at least two fish: one shy one to feed and a bold one to race.',
        best,
      });
    }
    const candidates = fish.filter((f) => f.eligible);
    if (candidates.length === 0) {
      return (this.last = {
        phase: 'unavailable',
        reason:
          'None of your fish can win this round: the shy one has to eat flakes and swim up to the surface for them.',
        best,
      });
    }
    const lowest = Math.min(...candidates.map((f) => f.boldness));
    const shy = candidates.filter((f) => f.boldness - lowest < 1e-9);
    const target = shy[Math.floor(this.random() * shy.length)] ?? shy[0];
    if (!target) throw new Error('FeedingGame.start: no target fish');
    this.round = {
      target,
      timeLeftS: ROUND_S,
      pinchesLeft: PINCHES_PER_ROUND,
      graceS: null,
      targetPortion: 0,
      rivalPortion: 0,
    };
    return (this.last = this.runningView(this.round));
  }

  /** Spends a pinch; false when no round is on or none are left. */
  pinch(): boolean {
    const round = this.round;
    if (!round || round.pinchesLeft === 0) return false;
    round.pinchesLeft -= 1;
    if (round.pinchesLeft === 0) round.graceS = LAST_PINCH_GRACE_S;
    this.last = this.runningView(round);
    return true;
  }

  /** Gives back a pinch whose food never went into the water (rate limit, full tank). */
  refund(): void {
    const round = this.round;
    if (!round || round.pinchesLeft >= PINCHES_PER_ROUND) return;
    round.pinchesLeft += 1;
    round.graceS = null;
    this.last = this.runningView(round);
  }

  /** Marks food particles dropped by this round's pinches; only bites of these score. */
  track(foodIds: Iterable<number>): void {
    for (const id of foodIds) this.dropped.add(id);
  }

  ate(eaten: readonly { fishId: string; portion: number; foodId?: number }[]): GameView {
    const round = this.round;
    if (!round) return this.last;
    for (const { fishId, portion, foodId } of eaten) {
      if (foodId === undefined || !this.dropped.has(foodId)) continue;
      if (fishId === round.target.id) round.targetPortion += portion;
      else round.rivalPortion += portion;
    }
    return (this.last = this.runningView(round));
  }

  update(deltaS: number): GameView {
    const round = this.round;
    if (!round) return this.last;
    round.timeLeftS -= deltaS;
    if (round.graceS !== null) round.graceS -= deltaS;
    if (round.timeLeftS <= 0 || (round.graceS !== null && round.graceS <= 0)) return this.finish();
    return (this.last = this.runningView(round));
  }

  finish(): GameView {
    const round = this.round;
    if (!round) return this.last;
    this.round = null;
    const score = scoreOf(round);
    const previous = this.best;
    const newBest = score > previous;
    if (newBest) {
      this.store.write(score);
      this.best = score;
    }
    return (this.last = {
      phase: 'done',
      targetName: round.target.name,
      score,
      best: Math.max(previous, score),
      newBest,
      targetAte: round.targetPortion > 0,
    });
  }

  cancel(): GameView {
    this.round = null;
    this.dropped.clear();
    return (this.last = { phase: 'idle', best: this.best });
  }

  private runningView(round: Round): GameView {
    const timeLeftS = Math.max(0, round.timeLeftS);
    const score = scoreOf(round);
    const last = this.last;
    // The panel shows whole seconds, so a frame that changes nothing it shows reuses the view.
    if (
      last.phase === 'running' &&
      last.targetId === round.target.id &&
      Math.ceil(last.timeLeftS) === Math.ceil(timeLeftS) &&
      last.pinchesLeft === round.pinchesLeft &&
      last.score === score &&
      last.best === this.best
    ) {
      return last;
    }
    return {
      phase: 'running',
      targetId: round.target.id,
      targetName: round.target.name,
      timeLeftS,
      pinchesLeft: round.pinchesLeft,
      score,
      best: this.best,
    };
  }
}

function scoreOf(round: Round): number {
  return Math.max(
    0,
    Math.round(
      round.targetPortion * TARGET_POINTS_PER_PORTION -
        round.rivalPortion * RIVAL_PENALTY_PER_PORTION,
    ),
  );
}
