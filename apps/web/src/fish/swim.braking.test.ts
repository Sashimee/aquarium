import { beforeAll, describe, expect, it } from 'vitest';
import { STEP_DT, World } from '@aquarium/sim';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { demoTank } from './demoStock';
import { isFinned, SWIM_MODES, SwimState } from './swim';

const SEED = 11;
const WARM_UP_S = 20;
const MEASURED_S = 100;
/** Slower than this a fish hovers on its idle undulation, coasting or not. */
const SWIMMING_BODY_LENGTHS_PER_S = 0.3;

interface BrakeTrace {
  /** Swimming frames on which the sim gives no thrust and does not glide: braking on drag. */
  braking: number;
  /** Braking frames drawn tail-still (drive below 0.5). */
  stillBraking: number;
}

/**
 * The freshwater demo run as `FishSystem` feeds it: the sim's speed, turn rate, glide and state
 * into each fish's `SwimState` at 30 Hz.
 */
function trace(speciesId: string, light: number): BrakeTrace {
  const { config } = demoTank(DEFAULT_TANK, SEED, 'freshwater');
  const world = new World(config);
  world.setLight(light);
  const species = config.species;
  const swims = config.fish.map((_, i) => {
    const content = species[world.speciesIndex[i] ?? -1];
    if (content === undefined) throw new Error(`fish ${i} has no species`);
    const mode = content.locomotion.swimmingMode;
    if (!isFinned(mode)) throw new Error(`${content.id} does not swim`);
    return new SwimState(
      world.bodyLength[i] ?? 0,
      content.locomotion.strouhal,
      SWIM_MODES[mode],
      i,
    );
  });
  const watched = config.fish.flatMap((f, i) => (f.species === speciesId ? [i] : []));
  if (watched.length === 0) throw new Error(`the freshwater demo stocks no ${speciesId}`);

  const result: BrakeTrace = { braking: 0, stillBraking: 0 };
  const steps = Math.round((WARM_UP_S + MEASURED_S) / STEP_DT);
  const warmUp = Math.round(WARM_UP_S / STEP_DT);
  for (let step = 0; step < steps; step++) {
    world.step();
    swims.forEach((swim, i) =>
      swim.advance(STEP_DT, {
        speed: world.speed[i] ?? 0,
        yawRate: world.yawRate[i] ?? 0,
        glide: world.gliding[i] ?? 0,
        state: world.state[i] ?? -1,
      }),
    );
    if (step < warmUp) continue;
    for (const i of watched) {
      const speed = world.speed[i] ?? 0;
      if (speed <= SWIMMING_BODY_LENGTHS_PER_S * (world.bodyLength[i] ?? 0)) continue;
      if (world.thrust[i] !== 0 || world.gliding[i] !== 0) continue;
      result.braking++;
      if ((swims[i]?.drive ?? 1) < 0.5) result.stillBraking++;
    }
  }
  return result;
}

describe.each([
  ['bronze-corydoras', 'night', 0],
  ['bronze-corydoras', 'day', 1],
  ['betta', 'night', 0],
  ['betta', 'day', 1],
] as const)('braking %s at %s', (speciesId, _, light) => {
  let result: BrakeTrace;
  beforeAll(() => {
    result = trace(speciesId, light);
  });

  it('meets braking runs, where the sim gives no thrust without gliding', () => {
    expect(result.braking).toBeGreaterThan(0);
  });

  it('never stills the tail while braking', () => {
    expect(result.stillBraking).toBe(0);
  });
});
