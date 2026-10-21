import { contagionFrom, syncTreatment } from './disease.ts';
import { stepFish } from './fish.ts';
import type { DeathRecord, LifecycleState, StepContext } from './types.ts';
import { stepWater } from './water.ts';

export function stepTank(
  state: LifecycleState,
  ctx: StepContext,
): { state: LifecycleState; deaths: DeathRecord[] } {
  const deaths: DeathRecord[] = [];
  const contagion = contagionFrom(state.fish);
  const medicine =
    state.medicine && state.medicine.untilMs > ctx.nowMs - ctx.dtHours * 3_600_000
      ? state.medicine
      : null;
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
      medicine,
      contagion,
    });
    if (f.alive && !next.alive && next.cause && next.diedAtMs !== null) {
      deaths.push({ fishId: f.id, cause: next.cause, diedAtMs: next.diedAtMs });
    }
    return next;
  });
  const { water, chemistry } = stepWater(state, state.fish, ctx);
  const remaining = medicine && medicine.untilMs > ctx.nowMs ? medicine : null;
  return {
    state: { water, chemistry, fish: syncTreatment(fish, remaining), medicine: remaining },
    deaths,
  };
}
