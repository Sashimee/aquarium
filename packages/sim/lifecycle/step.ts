import { stepFish } from './fish.ts';
import type { DeathRecord, LifecycleState, StepContext } from './types.ts';
import { stepWater } from './water.ts';

export function stepTank(
  state: LifecycleState,
  ctx: StepContext,
): { state: LifecycleState; deaths: DeathRecord[] } {
  const deaths: DeathRecord[] = [];
  const fish = state.fish.map((f) => {
    const spec = ctx.species.get(f.species);
    if (!spec) throw new Error(`lifecycle: unknown species "${f.species}"`);
    const next = stepFish(f, spec, {
      nowMs: ctx.nowMs,
      dtHours: ctx.dtHours,
      ammonia: state.water.ammonia,
      vacationFeeder: ctx.vacationFeeder,
      grace: ctx.grace,
    });
    if (f.alive && !next.alive && next.cause && next.diedAtMs !== null) {
      deaths.push({ fishId: f.id, cause: next.cause, diedAtMs: next.diedAtMs });
    }
    return next;
  });
  return { state: { water: stepWater(state.water, state.fish, ctx), fish }, deaths };
}
