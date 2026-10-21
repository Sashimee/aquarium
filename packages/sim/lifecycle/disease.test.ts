import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chemistryParametersSchema,
  DEFAULT_EQUIPMENT,
  MAX_MEDICINE_DOSES,
  newTankChemistry,
  speciesContentSummarySchema,
  type Water,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  addDose,
  applyCare,
  catchUp,
  contagionFrom,
  courseHours,
  CURE_COURSE_FRACTION,
  DEFAULT_WATER_PARAMETERS,
  diluteMedicine,
  DISEASE_IMMUNE_SPECIES,
  DISEASE_PROFILES,
  MAX_CATCH_UP_MS,
  NEW_FISH_WINDOW_MS,
  onsetRates,
  rollOnset,
  TANK_BIOLOAD_CAPACITY,
  type ActiveMedicine,
  type FishDisease,
  type LifecycleFish,
  type LifecycleState,
  type OnsetPressure,
  type SpeciesChemistryTable,
  type SpeciesTable,
  type TankEnvironment,
} from './index.ts';

const speciesDir = join(import.meta.dirname, '../../../content/species');
const parsed = readdirSync(speciesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) =>
    speciesContentSummarySchema
      .loose()
      .parse(JSON.parse(readFileSync(join(speciesDir, name), 'utf8'))),
  );
// Fed fish never starve, so a long run isolates what the disease does.
const species: SpeciesTable = new Map(
  parsed.map(
    (s) =>
      [s.id, s.id === 'neon-tetra' ? { ...s.lifecycle, hungerPerHour: 0 } : s.lifecycle] as const,
  ),
);
const speciesChemistry: SpeciesChemistryTable = new Map(
  parsed.map((s) => [s.id, s.chemistry] as const),
);
const chemistryParams = chemistryParametersSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/chemistry.json'), 'utf8')),
);
const env: TankEnvironment = {
  biome: 'freshwater',
  litres: 300,
  bioloadCapacity: TANK_BIOLOAD_CAPACITY,
  equipment: DEFAULT_EQUIPMENT,
  species,
  speciesChemistry,
  params: DEFAULT_WATER_PARAMETERS,
  chemistryParams,
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);
const clean: Water = { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0 };

const sickWith = (kind: FishDisease['kind'], severity: number): FishDisease => ({
  kind,
  sinceMs: T0,
  severity,
  treatedUntilMs: null,
});

function fishOf(id: string, over: Partial<LifecycleFish> = {}): LifecycleFish {
  const spec = species.get('neon-tetra');
  if (!spec) throw new Error('no neon-tetra');
  return {
    id,
    species: 'neon-tetra',
    bornAtMs: T0,
    size: spec.maxSizeM,
    hunger: 0,
    health: 1,
    alive: true,
    diedAtMs: null,
    cause: null,
    sex: 'female',
    stage: 'adult',
    lastBroodAtMs: null,
    disease: null,
    introducedAtMs: null,
    ...over,
  };
}

const tank = (
  fish: LifecycleFish[],
  over: Partial<LifecycleState> = {},
  water: Partial<Water> = {},
): LifecycleState => ({
  water: { ...clean, ...water },
  chemistry: newTankChemistry('freshwater'),
  fish,
  medicine: null,
  ...over,
});

function run(
  state: LifecycleState,
  ms: number,
  from = 0,
  grace = T0 - 1,
  environment: TankEnvironment = env,
) {
  return catchUp({
    ...environment,
    state,
    fromMs: T0 + from,
    toMs: T0 + from + ms,
    graceEndsAtMs: grace,
    vacationFeeder: true,
    breeding: new Map(),
    breedingEnvironment: {
      hasCave: false,
      maxAnimals: 60,
      bioloadCapacity: TANK_BIOLOAD_CAPACITY,
      newId: () => {
        throw new Error('no births expected');
      },
    },
  });
}

const school = (n: number, over: Partial<LifecycleFish> = {}) =>
  Array.from({ length: n }, (_, i) => fishOf(`fish-${i}`, over));

const uncycled = () => ({
  ...newTankChemistry('freshwater'),
  bacteria: { ammoniaOxidisers: 0, nitriteOxidisers: 0 },
});

const medicine = (over: Partial<ActiveMedicine> = {}): ActiveMedicine => ({
  kind: 'ich',
  potency: 'standard',
  doses: 1,
  untilMs: T0 + courseHours('ich', 'standard') * HOUR,
  ...over,
});

const calm: OnsetPressure = {
  temperatureStress: 0,
  pollution: 0,
  chemistryStress: 0,
  newFish: false,
  contagion: { ich: 0, 'fin-rot': 0, velvet: 0 },
  health: 1,
};

describe('onset pressure', () => {
  it('is zero in settled water with no sick tank-mate and no new fish', () => {
    expect(onsetRates(calm)).toEqual({ ich: 0, 'fin-rot': 0, velvet: 0 });
  });

  it('ignores the ordinary wobble below the deadband', () => {
    const rates = onsetRates({ ...calm, temperatureStress: 0.05, chemistryStress: 0.05 });
    expect(rates).toEqual({ ich: 0, 'fin-rot': 0, velvet: 0 });
  });

  it('ties each trigger to its disease', () => {
    const cold = onsetRates({ ...calm, temperatureStress: 1 });
    expect(cold.ich).toBeGreaterThan(0);
    expect(cold['fin-rot']).toBe(0);
    const dirty = onsetRates({ ...calm, pollution: 2 });
    expect(dirty['fin-rot']).toBeGreaterThan(0);
    expect(dirty.ich).toBe(0);
    const off = onsetRates({ ...calm, chemistryStress: 1 });
    expect(off.velvet).toBeGreaterThan(0);
    expect(off['fin-rot']).toBe(0);
  });

  it('puts a new fish at risk of ich and velvet but not fin rot', () => {
    const fresh = onsetRates({ ...calm, newFish: true });
    expect(fresh.ich).toBeGreaterThan(0);
    expect(fresh.velvet).toBeGreaterThan(0);
    expect(fresh['fin-rot']).toBe(0);
  });

  it('makes a weak fish likelier to catch it than a strong one', () => {
    const contagion = { ich: 1, 'fin-rot': 0, velvet: 0 };
    const weak = onsetRates({ ...calm, contagion, health: 0.3 });
    const strong = onsetRates({ ...calm, contagion, health: 1 });
    expect(weak.ich).toBeGreaterThan(strong.ich);
    expect(strong.ich).toBeGreaterThan(0);
  });

  it('counts only living, contagious tank-mates', () => {
    const total = contagionFrom([
      fishOf('a', { disease: sickWith('ich', 0.5) }),
      fishOf('b', { disease: sickWith('ich', 0.05) }),
      fishOf('c', { disease: sickWith('velvet', 1), alive: false }),
      fishOf('d'),
    ]);
    expect(total).toEqual({ ich: 0.5, 'fin-rot': 0, velvet: 0 });
  });
});

describe('the roll', () => {
  const rates = { ich: 0.5, 'fin-rot': 0.25, velvet: 0.25 };

  it('is a pure function of fish, step and rates', () => {
    for (let i = 0; i < 50; i++) {
      expect(rollOnset(`f${i}`, T0 + i, rates, 1)).toBe(rollOnset(`f${i}`, T0 + i, rates, 1));
    }
  });

  it('never fires without pressure', () => {
    for (let i = 0; i < 500; i++) {
      expect(rollOnset(`f${i}`, T0 + i, { ich: 0, 'fin-rot': 0, velvet: 0 }, 1)).toBeNull();
    }
  });

  it('draws every kind roughly in proportion to its rate', () => {
    const counts = { ich: 0, 'fin-rot': 0, velvet: 0 };
    for (let i = 0; i < 4000; i++) {
      const kind = rollOnset(`f${i}`, T0 + i * 600_000, rates, 1);
      if (kind) counts[kind]++;
    }
    expect(counts.ich).toBeGreaterThan(counts['fin-rot'] * 1.5);
    expect(counts['fin-rot']).toBeGreaterThan(300);
    expect(counts.velvet).toBeGreaterThan(300);
  });
});

describe('healthy water', () => {
  it('never starts an outbreak in 60 days among long-settled fish', () => {
    const r = run(tank(school(12)), 60 * DAY);
    expect(r.capped).toBe(false);
    expect(r.state.fish.every((f) => f.disease === null)).toBe(true);
    expect(r.timeline.filter((e) => e.kind === 'sick')).toEqual([]);
  });

  it('starts none during the new-account grace period either', () => {
    const state = tank(school(12), {}, { ammonia: 1.5 });
    const r = run(state, 2 * DAY, 0, T0 + 3 * DAY);
    expect(r.state.fish.every((f) => f.disease === null)).toBe(true);
  });
});

describe('outbreaks', () => {
  it('starts fin rot in water that stays polluted, and never ich', () => {
    const state = tank(school(12), { chemistry: uncycled() }, { ammonia: 0.9 });
    const r = run(state, 4 * DAY);
    const kinds = new Set(r.state.fish.map((f) => f.disease?.kind).filter(Boolean));
    expect(kinds.has('fin-rot')).toBe(true);
    expect(kinds.has('ich')).toBe(false);
    const sick = r.timeline.filter((e) => e.kind === 'sick');
    expect(sick.length).toBeGreaterThan(0);
  });

  it('starts ich and velvet in a new fish within its first week, and not once the week is over', () => {
    const fresh = school(40, { introducedAtMs: T0 });
    const early = run(tank(fresh), NEW_FISH_WINDOW_MS);
    const ill = early.state.fish.filter((f) => f.disease !== null);
    expect(ill.length).toBeGreaterThan(0);
    expect(ill.every((f) => f.disease?.kind !== 'fin-rot')).toBe(true);
    const settled = run(
      tank(school(40, { introducedAtMs: T0 - 2 * NEW_FISH_WINDOW_MS })),
      20 * DAY,
    );
    expect(settled.state.fish.every((f) => f.disease === null)).toBe(true);
  });

  it('spreads from a sick fish to tank-mates in clean water, and nowhere without one', () => {
    const mates = school(11);
    const infected = run(
      tank([fishOf('patient', { disease: sickWith('ich', 0.6) }), ...mates]),
      14 * DAY,
    );
    const caught = infected.state.fish.filter(
      (f) => f.id !== 'patient' && f.disease?.kind === 'ich',
    );
    expect(caught.length).toBeGreaterThan(0);
    const control = run(tank(school(12)), 14 * DAY);
    expect(control.state.fish.every((f) => f.disease === null)).toBe(true);
  });

  it('does not spread from a carcass', () => {
    const dead = fishOf('dead', {
      alive: false,
      diedAtMs: T0,
      cause: 'disease',
      disease: sickWith('ich', 1),
    });
    const r = run(tank([dead, ...school(11)]), 14 * DAY);
    expect(r.state.fish.filter((f) => f.alive).every((f) => f.disease === null)).toBe(true);
  });

  it('leaves the shrimp alone', () => {
    expect(DISEASE_IMMUNE_SPECIES.size).toBeGreaterThan(0);
    for (const id of DISEASE_IMMUNE_SPECIES) expect(species.has(id), id).toBe(true);
    const shrimp = Array.from({ length: 6 }, (_, i) =>
      fishOf(`shrimp-${i}`, { species: 'cherry-shrimp', introducedAtMs: T0, disease: null }),
    );
    const sick = fishOf('patient', { disease: sickWith('ich', 1) });
    const r = run(tank([sick, ...shrimp], {}, { ammonia: 0.05 }), 10 * DAY);
    expect(
      r.state.fish.filter((f) => f.species === 'cherry-shrimp').every((f) => f.disease === null),
    ).toBe(true);
  });
});

describe('progression, recovery and death', () => {
  it('makes an untreated fish worse, and eventually kills it of disease', () => {
    const state = tank([fishOf('a', { disease: sickWith('velvet', 0.5) })]);
    const day3 = run(state, 3 * DAY).state.fish[0];
    expect(day3?.disease?.severity).toBeGreaterThan(0.5);
    expect(day3?.health).toBeLessThan(1);
    const end = run(state, 30 * DAY);
    const fish = end.state.fish[0];
    expect(fish?.alive).toBe(false);
    expect(fish?.cause).toBe('disease');
    expect(end.deaths).toHaveLength(1);
  });

  it('kills faster the harsher the disease', () => {
    const lifetimes = (['ich', 'velvet'] as const).map((kind) => {
      const r = run(tank([fishOf('a', { disease: sickWith(kind, 0.5) })]), 40 * DAY);
      return (r.state.fish[0]?.diedAtMs ?? Infinity) - T0;
    });
    expect(lifetimes[1]).toBeLessThan(lifetimes[0] ?? 0);
    expect(lifetimes.every(Number.isFinite)).toBe(true);
  });

  it('lets fin rot heal by itself in calm water but never ich', () => {
    const rot = run(tank([fishOf('a', { disease: sickWith('fin-rot', 0.2) })]), 12 * DAY);
    expect(rot.state.fish[0]?.disease).toBeNull();
    expect(rot.state.fish[0]?.alive).toBe(true);
    const ich = run(tank([fishOf('a', { disease: sickWith('ich', 0.2) })]), 12 * DAY);
    expect(ich.state.fish[0]?.disease?.severity).toBeGreaterThan(0.2);
  });

  it('keeps fin rot from healing in stressed water', () => {
    const r = run(
      tank(
        [fishOf('a', { disease: sickWith('fin-rot', 0.2) })],
        { chemistry: uncycled() },
        { ammonia: 0.3 },
      ),
      3 * DAY,
    );
    expect(r.state.fish[0]?.disease?.severity).toBeGreaterThan(0.2);
  });
});

describe('treatment', () => {
  it.each(['ich', 'fin-rot', 'velvet'] as const)(
    'cures %s inside a standard course, whatever the severity',
    (kind) => {
      for (const severity of [0.1, 0.6, 1]) {
        const state = tank([fishOf('a', { disease: sickWith(kind, severity), health: 0.8 })], {
          medicine: medicine({ kind, untilMs: T0 + courseHours(kind, 'standard') * HOUR }),
        });
        const r = run(state, courseHours(kind, 'standard') * HOUR);
        expect(r.state.fish[0]?.disease, `${kind} ${severity}`).toBeNull();
        expect(r.state.fish[0]?.alive).toBe(true);
        expect(r.state.medicine).toBeNull();
      }
    },
  );

  it('cures within the stated share of the course', () => {
    const profile = DISEASE_PROFILES.ich;
    const state = tank([fishOf('a', { disease: sickWith('ich', 1) })], { medicine: medicine() });
    const hours = profile.courseHours * CURE_COURSE_FRACTION;
    expect(run(state, (hours - 2) * HOUR).state.fish[0]?.disease).not.toBeNull();
    expect(run(state, (hours + 2) * HOUR).state.fish[0]?.disease).toBeNull();
  });

  it('cures in half the time with the premium medicine', () => {
    const premium = medicine({
      potency: 'premium',
      untilMs: T0 + courseHours('ich', 'premium') * HOUR,
    });
    const state = tank([fishOf('a', { disease: sickWith('ich', 1) })], { medicine: premium });
    const r = run(state, courseHours('ich', 'premium') * HOUR);
    expect(r.state.fish[0]?.disease).toBeNull();
    expect(courseHours('ich', 'premium')).toBe(courseHours('ich', 'standard') / 2);
  });

  it('does nothing for a different disease', () => {
    const state = tank([fishOf('a', { disease: sickWith('velvet', 0.5) })], {
      medicine: medicine(),
    });
    const r = run(state, 3 * DAY);
    expect(r.state.fish[0]?.disease?.severity).toBeGreaterThan(0.5);
    expect(r.state.fish[0]?.disease?.treatedUntilMs).toBeNull();
  });

  it('marks a treated fish with the end of the course and clears it when the course ends', () => {
    const state = tank([fishOf('a', { disease: sickWith('ich', 1) })], { medicine: medicine() });
    const during = run(state, 2 * DAY).state;
    expect(during.fish[0]?.disease?.treatedUntilMs).toBe(medicine().untilMs);
    const after = run(during, 6 * DAY, 2 * DAY).state;
    expect(after.medicine).toBeNull();
  });

  it('stops curing when the course is cut short by a water change, and the disease comes back', () => {
    const state = tank([fishOf('a', { disease: sickWith('ich', 1) })], { medicine: medicine() });
    const day1 = run(state, DAY).state;
    const changed = applyCare(
      day1,
      { type: 'water_change' },
      'freshwater',
      chemistryParams,
      T0 + DAY,
    );
    if (!changed.ok) throw new Error(changed.reason);
    const cutEnd = changed.value.medicine?.untilMs ?? 0;
    expect(cutEnd).toBe(T0 + DAY + (medicine().untilMs - (T0 + DAY)) / 2);
    const after = run(changed.value, 4 * DAY, DAY);
    const left = after.state.fish[0]?.disease;
    expect(left).not.toBeNull();
    expect(left?.severity).toBeLessThan(1);
    expect(left?.treatedUntilMs).toBeNull();
    const later = run(after.state, 3 * DAY, 5 * DAY).state.fish[0]?.disease;
    expect(later?.severity).toBeGreaterThan(left?.severity ?? 1);
  });

  it('lets a second dose finish what an interrupted course began', () => {
    const state = tank([fishOf('a', { disease: sickWith('ich', 1) })], { medicine: medicine() });
    const day1 = run(state, DAY).state;
    const changed = applyCare(
      day1,
      { type: 'water_change' },
      'freshwater',
      chemistryParams,
      T0 + DAY,
    );
    if (!changed.ok) throw new Error(changed.reason);
    const redosed = addDose(changed.value.medicine, 'ich', 'standard', T0 + 2 * DAY);
    if (typeof redosed === 'string') throw new Error(redosed);
    expect(redosed.overdose).toBe(false);
    expect(redosed.medicine.doses).toBe(1);
    const after = run({ ...changed.value, medicine: redosed.medicine }, 5 * DAY, 2 * DAY);
    expect(after.state.fish[0]?.disease).toBeNull();
  });
});

describe('medicine in the water', () => {
  it('dilutes with a water change: half the time left and one dose fewer', () => {
    const m = medicine({ doses: 3, untilMs: T0 + 10 * HOUR });
    expect(diluteMedicine(m, T0 + 2 * HOUR)).toEqual({ ...m, doses: 2, untilMs: T0 + 6 * HOUR });
    expect(diluteMedicine(medicine({ doses: 1, untilMs: T0 + 10 * HOUR }), T0)?.doses).toBe(0);
    expect(diluteMedicine(m, T0 + 11 * HOUR)).toBeNull();
    expect(diluteMedicine(null, T0)).toBeNull();
  });

  it('adds a dose, flags the overdose and refuses a fourth', () => {
    const first = addDose(null, 'ich', 'standard', T0);
    if (typeof first === 'string') throw new Error(first);
    expect(first.overdose).toBe(false);
    const second = addDose(first.medicine, 'ich', 'standard', T0 + HOUR);
    if (typeof second === 'string') throw new Error(second);
    expect(second.overdose).toBe(true);
    expect(second.medicine.doses).toBe(2);
    expect(second.medicine.untilMs).toBe(T0 + HOUR + courseHours('ich', 'standard') * HOUR);
    const third = addDose(second.medicine, 'ich', 'standard', T0 + 2 * HOUR);
    if (typeof third === 'string') throw new Error(third);
    expect(third.medicine.doses).toBe(MAX_MEDICINE_DOSES);
    expect(addDose(third.medicine, 'ich', 'standard', T0 + 3 * HOUR)).toBe('at-limit');
  });

  it('refuses another kind while a course runs, and starts afresh after it ended', () => {
    const m = medicine();
    expect(addDose(m, 'velvet', 'standard', T0 + HOUR)).toBe('other-medicine');
    const fresh = addDose(m, 'velvet', 'standard', m.untilMs + 1);
    if (typeof fresh === 'string') throw new Error(fresh);
    expect(fresh.medicine.doses).toBe(1);
    expect(fresh.overdose).toBe(false);
  });

  it('lets another kind replace a residue left by a water change', () => {
    const residue = diluteMedicine(medicine({ doses: 1 }), T0 + HOUR);
    const swapped = addDose(residue, 'velvet', 'standard', T0 + 2 * HOUR);
    if (typeof swapped === 'string') throw new Error(swapped);
    expect(swapped.medicine.kind).toBe('velvet');
    expect(swapped.medicine.doses).toBe(1);
    expect(swapped.overdose).toBe(false);
  });

  it('poisons every fish, sick or not, once there is more than one dose, and says why', () => {
    const calmTank = tank(school(6), { medicine: medicine({ doses: 3, untilMs: T0 + 20 * DAY }) });
    const r = run(calmTank, 20 * DAY);
    expect(r.state.fish.every((f) => !f.alive && f.cause === 'water_quality')).toBe(true);
    const one = run(tank(school(6), { medicine: medicine({ untilMs: T0 + 20 * DAY }) }), 20 * DAY);
    expect(one.state.fish.every((f) => f.alive && f.health === 1)).toBe(true);
  });

  it('hurts a little in a short overdose and heals once the water is changed', () => {
    const state = tank(school(3), { medicine: medicine({ doses: 3, untilMs: T0 + 2 * DAY }) });
    const poisoned = run(state, DAY).state;
    const worst = Math.min(...poisoned.fish.map((f) => f.health));
    expect(worst).toBeLessThan(1);
    expect(worst).toBeGreaterThan(0);
    const changed = applyCare(
      poisoned,
      { type: 'water_change' },
      'freshwater',
      chemistryParams,
      T0 + DAY,
    );
    if (!changed.ok) throw new Error(changed.reason);
    expect(changed.value.medicine?.doses).toBe(2);
    const course = run(changed.value, 5 * DAY, DAY);
    expect(course.state.fish.every((f) => f.alive)).toBe(true);
    expect(course.state.medicine).toBeNull();
  });
});

describe('catch-up', () => {
  const start = tank(
    [fishOf('patient', { disease: sickWith('ich', 0.4) }), ...school(8)],
    {},
    { ammonia: 0.4 },
  );

  it('is deterministic', () => {
    expect(run(start, 20 * DAY)).toEqual(run(start, 20 * DAY));
  });

  it('gives the same outcome in one long catch-up as in two that meet on a step', () => {
    const whole = run(start, 12 * DAY);
    const half = run(start, 5 * DAY);
    const rest = run(half.state, 7 * DAY, 5 * DAY);
    expect(rest.state).toEqual(whole.state);
  });

  it('simulates at most the last 60 days of a longer absence, and still lands in a legal state', () => {
    const r = run(start, 400 * DAY);
    expect(r.capped).toBe(true);
    expect(r.elapsedMinutes).toBe(MAX_CATCH_UP_MS / 60_000);
    for (const f of r.state.fish) {
      if (f.disease) {
        expect(f.disease.severity).toBeGreaterThan(0);
        expect(f.disease.severity).toBeLessThanOrEqual(1);
        expect(f.disease.sinceMs).toBeLessThanOrEqual(T0 + 400 * DAY);
      }
      expect(f.health).toBeGreaterThanOrEqual(0);
      expect(f.health).toBeLessThanOrEqual(1);
    }
  });

  it('runs a medicine course that ended during the absence to its end', () => {
    const state = tank([fishOf('a', { disease: sickWith('ich', 0.9) })], { medicine: medicine() });
    const r = run(state, 30 * DAY);
    expect(r.state.medicine).toBeNull();
    expect(r.state.fish[0]?.disease).toBeNull();
    expect(r.state.fish[0]?.alive).toBe(true);
  });

  it('records the onset as one sick entry per fish', () => {
    const r = run(tank(school(12), {}, { ammonia: 0.9 }), 6 * DAY);
    const sick = r.timeline.filter((e) => e.kind === 'sick');
    expect(new Set(sick.map((e) => (e.kind === 'sick' ? e.fishId : ''))).size).toBe(sick.length);
  });
});

describe('medicine residue and heat', () => {
  it('lets a dose on top of a diluted single dose stack to one dose, never an overdose', () => {
    const residue = diluteMedicine(medicine({ doses: 1, untilMs: T0 + 10 * HOUR }), T0);
    const topped = addDose(residue, 'ich', 'standard', T0 + HOUR);
    if (typeof topped === 'string') throw new Error(topped);
    expect(topped).toMatchObject({ overdose: false, medicine: { doses: 1 } });
  });

  it('still flags a dose on top of two diluted doses', () => {
    const thinned = diluteMedicine(medicine({ doses: 3, untilMs: T0 + 10 * HOUR }), T0);
    const topped = addDose(thinned, 'ich', 'standard', T0 + HOUR);
    if (typeof topped === 'string') throw new Error(topped);
    expect(topped.overdose).toBe(true);
  });

  it('cures ich in warm water the fish tolerates, slowly and without medicine', () => {
    const warm = { ...newTankChemistry('freshwater'), temperatureC: 31 };
    const heatProof = new Map(speciesChemistry);
    const chem = speciesChemistry.get('neon-tetra');
    if (!chem) throw new Error('no chemistry');
    heatProof.set('neon-tetra', { ...chem, temperatureC: [29, 34] });
    const state = tank([fishOf('a', { disease: sickWith('ich', 0.5) })], { chemistry: warm });
    const result = run(state, 12 * DAY, 0, T0 - 1, { ...env, speciesChemistry: heatProof });
    expect(result.state.fish[0]?.disease).toBeNull();
  });

  it('heals fin rot through small water wobble below the deadbands', () => {
    const state = tank([fishOf('a', { disease: sickWith('fin-rot', 0.5) })], {}, { ammonia: 0.01 });
    const left = run(state, 10 * DAY).state.fish[0]?.disease?.severity ?? 0;
    expect(left).toBeLessThan(0.5);
  });
});
