import { describe, expect, it } from 'vitest';
import { STEP_DT, World } from '@aquarium/sim';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { demoTank } from './demoStock';
import { isFinned, SWIM_MODES, SwimState } from './swim';

const SEED = 11;
const WARM_UP_S = 20;
const MEASURED_S = 100;
/** Slower than this a fish hovers on its idle undulation, coasting or not. */
const SWIMMING_BODY_LENGTHS_PER_S = 0.3;
/** A brake from top speed down to a forage or hover speed, on drag alone. */
const LONGEST_BRAKE_S = 2.5;

interface BrakeTrace {
  /** Swimming frames on which the sim's thrust is exactly 0. */
  unpowered: number;
  /** Swimming frames drawn tail-still (drive below 0.5) while the speed held or rose. */
  stillUnslowed: number;
  longestStillS: number;
}

/**
 * The freshwater demo run as `FishSystem` feeds it: the sim's speed, turn rate, thrust and state
 * into each fish's `SwimState` at 30 Hz, against the top speed the sim normalises thrust by.
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
      world.maxSpeed[i] ?? 0,
    );
  });
  const watched = config.fish.flatMap((f, i) => (f.species === speciesId ? [i] : []));
  if (watched.length === 0) throw new Error(`the freshwater demo stocks no ${speciesId}`);

  const result: BrakeTrace = { unpowered: 0, stillUnslowed: 0, longestStillS: 0 };
  const previous = new Map<number, number>();
  const stillRun = new Map<number, number>();
  const steps = Math.round((WARM_UP_S + MEASURED_S) / STEP_DT);
  const warmUp = Math.round(WARM_UP_S / STEP_DT);
  for (let step = 0; step < steps; step++) {
    world.step();
    swims.forEach((swim, i) =>
      swim.advance(STEP_DT, {
        speed: world.speed[i] ?? 0,
        yawRate: world.yawRate[i] ?? 0,
        thrust: world.thrust[i] ?? 0,
        state: world.state[i] ?? -1,
      }),
    );
    for (const i of watched) {
      const speed = world.speed[i] ?? 0;
      const before = previous.get(i) ?? speed;
      previous.set(i, speed);
      if (step < warmUp) continue;
      const length = world.bodyLength[i] ?? 0;
      if (speed <= SWIMMING_BODY_LENGTHS_PER_S * length) {
        stillRun.set(i, 0);
        continue;
      }
      if (world.thrust[i] === 0) result.unpowered++;
      const still = (swims[i]?.drive ?? 1) < 0.5;
      if (still && speed >= before) result.stillUnslowed++;
      const run = still ? (stillRun.get(i) ?? 0) + 1 : 0;
      stillRun.set(i, run);
      result.longestStillS = Math.max(result.longestStillS, run * STEP_DT);
    }
  }
  return result;
}

describe.each([
  ['bronze-corydoras', 'night', 0],
  ['bronze-corydoras', 'day', 1],
  ['betta', 'night', 0],
  ['betta', 'day', 1],
] as const)('braking %s at %s under the powered-frame rule', (speciesId, _, light) => {
  const result = trace(speciesId, light);

  it('meets braking runs, where the sim gives no thrust without coasting', () => {
    expect(result.unpowered).toBeGreaterThan(0);
  });

  it('stills the tail only while the sim slows the fish', () => {
    expect(result.stillUnslowed).toBe(0);
  });

  it('beats again within one brake from top speed', () => {
    expect(result.longestStillS).toBeLessThan(LONGEST_BRAKE_S);
  });
});
