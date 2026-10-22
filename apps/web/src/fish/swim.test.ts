import { describe, expect, it } from 'vitest';
import { FishState } from '@aquarium/sim';
import {
  amplitudeScale,
  BITE_CLOSE_S,
  BITE_OPEN_S,
  biteGape,
  BREATH_GAPE,
  envelopeAt,
  IDLE_AMPLITUDE,
  IDLE_TAIL_BEAT_HZ,
  MAX_BEND,
  MAX_TAIL_BEAT_HZ,
  MOUTH_LEAD_CYCLES,
  PECK_FIRST_S,
  PECK_HOLD_BODY_LENGTHS_PER_S,
  PECK_JAB_BODY_LENGTHS,
  PECK_MAX_INTERVAL_S,
  PECK_MIN_INTERVAL_S,
  POSE_STILLNESS,
  EXERTED_VENTILATION_HZ,
  RESTING_VENTILATION_HZ,
  SWIM_MODES,
  SwimState,
  tailBeatHz,
  turnCurvature,
} from './swim';

const TAU = Math.PI * 2;

describe('tailBeatHz', () => {
  it('follows f = St·U/A with A = 0.2 L', () => {
    expect(tailBeatHz(0.12, 0.032, 0.3)).toBeCloseTo(5.625, 6);
    expect(tailBeatHz(0.24, 0.032, 0.3)).toBeCloseTo(11.25, 6);
  });

  it('keeps an idle beat when hovering or given a negative speed', () => {
    expect(tailBeatHz(0, 0.05, 0.3)).toBe(IDLE_TAIL_BEAT_HZ);
    expect(tailBeatHz(-1, 0.05, 0.3)).toBe(IDLE_TAIL_BEAT_HZ);
  });

  it('caps bursts below display aliasing', () => {
    expect(tailBeatHz(2, 0.02, 0.3)).toBe(MAX_TAIL_BEAT_HZ);
  });

  it('rejects a non-positive or NaN length', () => {
    expect(() => tailBeatHz(0.1, 0, 0.3)).toThrow(RangeError);
    expect(() => tailBeatHz(0.1, Number.NaN, 0.3)).toThrow(RangeError);
  });
});

describe('amplitudeScale', () => {
  it('runs from the idle fraction at rest to 1 at cruising speed', () => {
    expect(amplitudeScale(0, 0.05, 1)).toBe(IDLE_AMPLITUDE);
    expect(amplitudeScale(0.075, 0.05, 1)).toBe(1);
    expect(amplitudeScale(5, 0.05, 1)).toBe(1);
  });

  it('rises monotonically in between', () => {
    const samples = [0, 0.01, 0.02, 0.04, 0.06, 0.075].map((u) => amplitudeScale(u, 0.05, 1));
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1] ?? Infinity);
    }
  });
});

describe('turnCurvature', () => {
  it('is yaw rate over speed, signed by turn direction', () => {
    expect(turnCurvature(1, 0.1, 0.05)).toBeCloseTo(10, 9);
    expect(turnCurvature(-1, 0.1, 0.05)).toBeCloseTo(-10, 9);
    expect(turnCurvature(0, 0.1, 0.05)).toBe(0);
  });

  it('floors the speed and clamps the bend when turning on the spot', () => {
    expect(turnCurvature(10, 0, 0.05)).toBeCloseTo(MAX_BEND / 0.05, 9);
    expect(turnCurvature(-10, 0, 0.05)).toBeCloseTo(-MAX_BEND / 0.05, 9);
    expect(turnCurvature(0.5, 0, 0.05)).toBeCloseTo(0.5 / 0.025, 9);
  });
});

describe('SWIM_MODES', () => {
  it('normalises every envelope to 1 at the tail tip', () => {
    for (const mode of Object.values(SWIM_MODES)) expect(envelopeAt(mode, 1)).toBeCloseTo(1, 9);
  });

  it('keeps the carangiform head stiffer than the anguilliform head', () => {
    const mid = 0.4;
    expect(envelopeAt(SWIM_MODES.carangiform, mid)).toBeLessThan(
      envelopeAt(SWIM_MODES.anguilliform, mid),
    );
  });
});

describe('SwimState', () => {
  it('integrates the phase at the Strouhal frequency and wraps it', () => {
    const state = new SwimState(0.032, 0.3, SWIM_MODES.carangiform, 0);
    state.advance(0.1, { speed: 0.12, yawRate: 0, thrust: 1, state: FishState.Cruise });
    expect(state.frequency).toBeCloseTo(5.625, 6);
    expect(state.phase).toBeCloseTo((TAU * 0.5625) % TAU, 6);
    for (let i = 0; i < 100; i++)
      state.advance(0.033, { speed: 0.12, yawRate: 0, thrust: 1, state: FishState.Cruise });
    expect(state.phase).toBeGreaterThanOrEqual(0);
    expect(state.phase).toBeLessThan(TAU);
    expect(state.finPhase).toBeLessThan(TAU);
  });

  it('beats the pectorals at their idle rate while hovering', () => {
    const state = new SwimState(0.12, 0.3, SWIM_MODES.labriform, 0);
    state.advance(0.1, { speed: 0, yawRate: 0, thrust: 1, state: FishState.Cruise });
    expect(state.finPhase).toBeCloseTo(TAU * SWIM_MODES.labriform.pectoralIdleHz * 0.1, 6);
  });

  it('eases the bend towards the turn instead of snapping', () => {
    const state = new SwimState(0.05, 0.3, SWIM_MODES.subcarangiform, 0);
    const target = turnCurvature(1, 0.1, 0.05);
    state.advance(0.02, { speed: 0.1, yawRate: 1, thrust: 1, state: FishState.Cruise });
    expect(state.curvature).toBeGreaterThan(0);
    expect(state.curvature).toBeLessThan(target);
    for (let i = 0; i < 60; i++)
      state.advance(0.02, { speed: 0.1, yawRate: 1, thrust: 1, state: FishState.Cruise });
    expect(state.curvature).toBeCloseTo(target, 3);
  });

  it('leaves the phase alone for a zero step and rejects negative ones', () => {
    const state = new SwimState(0.05, 0.3, SWIM_MODES.carangiform, 1);
    state.advance(0, { speed: 0.1, yawRate: 0, thrust: 1, state: FishState.Cruise });
    expect(state.phase).toBe(1);
    expect(() =>
      state.advance(-0.01, { speed: 0.1, yawRate: 0, thrust: 1, state: FishState.Cruise }),
    ).toThrow(RangeError);
    expect(() =>
      state.advance(Number.NaN, { speed: 0.1, yawRate: 0, thrust: 1, state: FishState.Cruise }),
    ).toThrow(RangeError);
  });

  describe('burst and coast', () => {
    // Neon tetra from the T18 audit: 3.2 cm, about 3.4 BL/s, 0.17 s kicks and 0.47 s glides.
    const length = 0.032;
    const speed = 3.4 * length;
    const step = 1 / 60;
    const run = (state: SwimState, seconds: number, thrust: number): void => {
      for (let t = 0; t < seconds; t += step)
        state.advance(step, { speed, yawRate: 0, thrust, state: FishState.Cruise });
    };

    it('lets the tail fall almost still within one tail period of a coast', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      run(state, 0.17, 0.6);
      expect(state.amplitude).toBeCloseTo(1, 2);
      const period = 1 / state.frequency;
      run(state, period, 0);
      expect(state.amplitude).toBeLessThan(0.08);
      run(state, 0.47 - period, 0);
      expect(state.amplitude).toBeLessThan(0.01);
    });

    it('fades instead of cutting the beat on the first frame of a coast', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      run(state, 0.17, 0.6);
      state.advance(step, { speed, yawRate: 0, thrust: 0, state: FishState.Cruise });
      expect(state.amplitude).toBeGreaterThan(0.5);
    });

    it('beats again within a few frames of the next kick', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      run(state, 0.5, 0);
      run(state, 0.1, 0.6);
      expect(state.amplitude).toBeGreaterThan(0.9);
    });

    it('keeps the station-holding undulation of a fish at rest', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      for (let i = 0; i < 120; i++)
        state.advance(step, { speed: 0, yawRate: 0, thrust: 0, state: FishState.Cruise });
      expect(state.amplitude).toBe(IDLE_AMPLITUDE);
    });

    it('treats a drive outside 0..1 as its nearest bound', () => {
      expect(amplitudeScale(speed, length, 2)).toBe(1);
      expect(amplitudeScale(speed, length, -1)).toBe(0);
    });
  });

  describe('gill ventilation', () => {
    const length = 0.05;
    const step = 1 / 60;
    const hover = { speed: 0, yawRate: 0, thrust: 0, state: FishState.Cruise };
    const cruise = { speed: 2 * length, yawRate: 0, thrust: 1, state: FishState.Cruise };
    const run = (state: SwimState, seconds: number, sample: typeof hover): void => {
      for (let t = 0; t < seconds; t += step) state.advance(step, sample);
    };
    const rate = (state: SwimState, sample: typeof hover): number => {
      const before = state.ventilationPhase;
      state.advance(0.01, sample);
      return ((state.ventilationPhase - before + TAU) % TAU) / TAU / 0.01;
    };

    it('starts closed and pumps at the resting rate while hovering', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      expect(state.gillOpening).toBe(0);
      const restingRate =
        RESTING_VENTILATION_HZ + (EXERTED_VENTILATION_HZ - RESTING_VENTILATION_HZ) * IDLE_AMPLITUDE;
      expect(rate(state, hover)).toBeCloseTo(restingRate, 3);
    });

    it('opens and closes once per beat without leaving 0..1', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      const seen: number[] = [];
      for (let i = 0; i < 600; i++) {
        state.advance(step, cruise);
        seen.push(state.gillOpening);
      }
      expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...seen)).toBeLessThanOrEqual(1);
      expect(Math.min(...seen)).toBeLessThan(0.01);
      expect(Math.max(...seen)).toBeGreaterThan(0.9);
      expect(state.ventilationPhase).toBeLessThan(TAU);
    });

    it('breathes harder after sustained swimming and settles back over seconds', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      run(state, 5, hover);
      const resting = rate(state, hover);
      run(state, 15, cruise);
      expect(rate(state, cruise)).toBeCloseTo(EXERTED_VENTILATION_HZ, 1);
      state.advance(step, hover);
      expect(rate(state, hover)).toBeGreaterThan(EXERTED_VENTILATION_HZ * 0.95);
      run(state, 15, hover);
      expect(rate(state, hover)).toBeCloseTo(resting, 2);
    });

    it('does not follow a single tail kick', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      run(state, 5, hover);
      const resting = rate(state, hover);
      run(state, 0.17, cruise);
      expect(rate(state, hover)).toBeLessThan(resting * 1.2);
    });
  });

  describe('buccal pumping', () => {
    const length = 0.05;
    const step = 1 / 240;
    const hover = { speed: 0, yawRate: 0, thrust: 0, state: FishState.Cruise };
    const cruise = { speed: 2 * length, yawRate: 0, thrust: 1, state: FishState.Cruise };
    const run = (state: SwimState, seconds: number, sample: typeof hover): void => {
      for (let t = 0; t < seconds; t += step) state.advance(step, sample);
    };
    /** Mouth and gill-cover openings and the ventilation phase over `seconds`, sampled every step. */
    const trace = (state: SwimState, seconds: number, sample: typeof hover) => {
      const mouth: number[] = [];
      const gills: number[] = [];
      const phase: number[] = [];
      for (let t = 0; t < seconds; t += step) {
        state.advance(step, sample);
        mouth.push(state.mouthOpening);
        gills.push(state.gillOpening);
        phase.push(state.ventilationPhase);
      }
      return { mouth, gills, phase };
    };
    const peaks = (xs: readonly number[]): number =>
      xs.filter((x, i) => x > (xs[i - 1] ?? Infinity) && x >= (xs[i + 1] ?? Infinity)).length;
    const argmax = (xs: readonly number[]): number => xs.indexOf(Math.max(...xs));

    it('gapes a breath no wider than a share of a bite and closes fully between breaths', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      const { mouth } = trace(state, 20, cruise);
      expect(Math.min(...mouth)).toBeGreaterThanOrEqual(0);
      expect(Math.min(...mouth)).toBeLessThan(0.002);
      expect(Math.max(...mouth)).toBeLessThanOrEqual(BREATH_GAPE + 1e-9);
      expect(Math.max(...mouth)).toBeGreaterThan(BREATH_GAPE * 0.95);
    });

    it('opens its widest a fixed share of a cycle ahead of the gill covers', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      run(state, 10, hover);
      const { mouth, gills, phase } = trace(state, 1 / 1.2, hover);
      const atMouth = phase[argmax(mouth)] ?? Number.NaN;
      const atGills = phase[argmax(gills)] ?? Number.NaN;
      const lead = (((atGills - atMouth) / TAU) % 1) + 1;
      expect(lead % 1).toBeCloseTo(MOUTH_LEAD_CYCLES, 2);
    });

    it('pumps once per ventilation beat, faster and wider after sustained swimming', () => {
      const resting = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      run(resting, 15, hover);
      const atRest = trace(resting, 10, hover);
      const working = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      run(working, 15, cruise);
      const atWork = trace(working, 10, cruise);
      expect(peaks(atRest.mouth)).toBe(peaks(atRest.gills));
      expect(peaks(atWork.mouth)).toBe(peaks(atWork.gills));
      expect(peaks(atWork.mouth)).toBeGreaterThan(peaks(atRest.mouth) * 1.5);
      expect(Math.max(...atWork.mouth)).toBeGreaterThan(Math.max(...atRest.mouth) * 1.4);
    });

    it('gapes fully on a bite and is back to breathing once it closes', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      run(state, 2, hover);
      state.bite();
      expect(state.mouthOpening).toBeGreaterThanOrEqual(0);
      state.advance(BITE_OPEN_S, hover);
      expect(state.mouthOpening).toBeCloseTo(1, 6);
      state.advance(BITE_CLOSE_S, hover);
      expect(state.mouthOpening).toBeLessThanOrEqual(BREATH_GAPE);
      expect(state.sinceBite).toBeCloseTo(BITE_OPEN_S + BITE_CLOSE_S, 9);
    });

    it('carries on from the current gape when it bites again mid-bite', () => {
      for (const into of [0.02, 0.08, 0.15, 0.24]) {
        const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
        state.bite();
        state.advance(into, hover);
        const before = state.mouthOpening;
        state.bite();
        expect(state.mouthOpening, `bite again ${into} s in`).toBeCloseTo(before, 6);
        const { mouth } = trace(state, BITE_OPEN_S, hover);
        expect(Math.max(...mouth)).toBeGreaterThan(0.99);
      }
    });

    it('is shut on the first frame of a fish that never bit, and only a breath wide', () => {
      const state = new SwimState(length, 0.3, SWIM_MODES.subcarangiform, 0);
      expect(state.sinceBite).toBe(Infinity);
      expect(state.mouthOpening).toBeLessThanOrEqual(BREATH_GAPE);
    });
  });

  it('rejects a non-positive length', () => {
    expect(() => new SwimState(0, 0.3, SWIM_MODES.carangiform, 0)).toThrow(RangeError);
  });
});

describe('biteGape', () => {
  it('opens to 1 and closes to 0 over the bite', () => {
    expect(biteGape(0)).toBe(0);
    expect(biteGape(BITE_OPEN_S)).toBe(1);
    expect(biteGape(BITE_OPEN_S + BITE_CLOSE_S)).toBe(0);
    expect(biteGape(BITE_OPEN_S + BITE_CLOSE_S / 2)).toBeCloseTo(0.5, 9);
  });

  it('rises monotonically, then falls monotonically', () => {
    const at = (n: number, from: number, span: number): number[] =>
      Array.from({ length: n + 1 }, (_, i) => biteGape(from + (span * i) / n));
    const rise = at(50, 0, BITE_OPEN_S);
    const fall = at(50, BITE_OPEN_S, BITE_CLOSE_S);
    expect(rise).toEqual([...rise].sort((a, b) => a - b));
    expect(fall).toEqual([...fall].sort((a, b) => b - a));
  });

  it('is shut before, after and outside any bite', () => {
    expect(biteGape(-0.01)).toBe(0);
    expect(biteGape(Infinity)).toBe(0);
    expect(biteGape(Number.NaN)).toBe(0);
    expect(biteGape(10)).toBe(0);
  });
});

describe('cleaning station motion', () => {
  const length = 0.085;
  const step = 1 / 60;
  const sample = (state: number, speed: number) => ({ speed, yawRate: 0, thrust: 1, state });
  const wrasse = (phaseOffset = 0) => new SwimState(length, 0.3, SWIM_MODES.labriform, phaseOffset);

  /** Start times of the pecks over `seconds`, sampled once a frame of `frameS`. */
  function peckTimes(
    state: SwimState,
    seconds: number,
    speed: number,
    kind: number = FishState.Clean,
    frameS = step,
  ): number[] {
    const starts: number[] = [];
    let before = state.sincePeck;
    for (let i = 1; i * frameS <= seconds + 1e-9; i++) {
      state.advance(frameS, sample(kind, speed));
      if (state.sincePeck < before) starts.push(i * frameS - state.sincePeck);
      before = state.sincePeck;
    }
    return starts;
  }

  it('stills a posing client to a quarter of its hover undulation, and lets it go again', () => {
    const posing = wrasse();
    const hovering = wrasse();
    for (let i = 0; i < 180; i++) {
      posing.advance(step, sample(FishState.Pose, 0.1 * 0.08));
      hovering.advance(step, sample(FishState.Cruise, 0.1 * 0.08));
    }
    expect(posing.stillness).toBeGreaterThan(0.99);
    expect(posing.amplitude).toBeCloseTo(hovering.amplitude * (1 - POSE_STILLNESS), 2);
    for (let i = 0; i < 180; i++) posing.advance(step, sample(FishState.Cruise, 0.1 * 0.08));
    expect(posing.amplitude).toBeCloseTo(hovering.amplitude, 2);
  });

  it('eases into the pose rather than freezing in one frame', () => {
    const state = wrasse();
    state.advance(step, sample(FishState.Pose, 0));
    expect(state.stillness).toBeGreaterThan(0);
    expect(state.stillness).toBeLessThan(0.1);
  });

  it('pecks while holding at a contact: first soon after arriving, then every 0.25-0.5 s', () => {
    const starts = peckTimes(wrasse(), 3, 0.05 * length);
    expect(starts[0]).toBeCloseTo(PECK_FIRST_S, 1);
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] ?? 0));
    expect(gaps.length).toBeGreaterThanOrEqual(5);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(PECK_MIN_INTERVAL_S - step);
      expect(gap).toBeLessThanOrEqual(PECK_MAX_INTERVAL_S + step);
    }
    expect(new Set(gaps.map((g) => g.toFixed(2))).size).toBeGreaterThan(1);
  });

  it('pecks on the same beat at 30 Hz as at 144 Hz', () => {
    const slow = peckTimes(wrasse(1), 3, 0, FishState.Clean, 1 / 30);
    const fast = peckTimes(wrasse(1), 3, 0, FishState.Clean, 1 / 144);
    expect(slow.length).toBeGreaterThanOrEqual(6);
    expect(slow).toHaveLength(fast.length);
    slow.forEach((t, i) => expect(t).toBeCloseTo(fast[i] ?? NaN, 6));
  });

  it('shows one to four pecks in a hold of 0.3-1.2 s', () => {
    for (const offset of [0, 1, 2.5, 4]) {
      expect(peckTimes(wrasse(offset), 0.3, 0).length).toBeGreaterThanOrEqual(1);
      expect(peckTimes(wrasse(offset), 1.2, 0).length).toBeLessThanOrEqual(4);
    }
  });

  it('snaps the jaws and jerks the head forward at each peck, then settles', () => {
    const state = wrasse();
    let mouth = 0;
    let jab = 0;
    for (let t = 0; t < PECK_FIRST_S + BITE_OPEN_S + step; t += step) {
      state.advance(step, sample(FishState.Clean, 0));
      mouth = Math.max(mouth, state.mouthOpening);
      jab = Math.max(jab, state.jab);
    }
    expect(mouth).toBeGreaterThan(0.9);
    expect(jab).toBeGreaterThan(0.9 * PECK_JAB_BODY_LENGTHS);
    expect(jab).toBeLessThanOrEqual(PECK_JAB_BODY_LENGTHS);
    for (let t = 0; t < 1; t += step) state.advance(step, sample(FishState.Cruise, 0.08));
    expect(state.jab).toBe(0);
  });

  it('does not peck while darting between contacts or outside Clean', () => {
    const darting = wrasse();
    expect(peckTimes(darting, 2, PECK_HOLD_BODY_LENGTHS_PER_S * length * 2)).toEqual([]);
    expect(darting.jab).toBe(0);
    expect(peckTimes(wrasse(), 2, 0, FishState.Cruise)).toEqual([]);
    expect(peckTimes(wrasse(), 2, 0, FishState.Pose)).toEqual([]);
  });

  it('waits the first-peck delay again after each dart', () => {
    const state = wrasse();
    peckTimes(state, 0.6, 0);
    for (let i = 0; i < 30; i++) state.advance(step, sample(FishState.Clean, length));
    const starts = peckTimes(state, 0.5, 0);
    expect(starts[0]).toBeCloseTo(PECK_FIRST_S, 1);
  });
});
