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
    const chemSpec = ctx.speciesChemistry.get(f.species);
    if (!spec || !chemSpec) throw new Error(`lifecycle: unknown species "${f.species}"`);
    const next = stepFish(f, spec, chemSpec, {
      nowMs: ctx.nowMs,
      dtHours: ctx.dtHours,
      ammonia: state.water.ammonia,
      chemistry: state.chemistry,
      chemistryParams: ctx.chemistryParams,
      vacationFeeder: ctx.vacationFeeder,
      grace: ctx.grace,
    });
    if (f.alive && !next.alive && next.cause && next.diedAtMs !== null) {
      deaths.push({ fishId: f.id, cause: next.cause, diedAtMs: next.diedAtMs });
    }
    return next;
  });
  const { water, chemistry } = stepWater(state, state.fish, ctx);
  return { state: { water, chemistry, fish }, deaths };
}
