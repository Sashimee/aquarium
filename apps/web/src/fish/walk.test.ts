import type { Collider } from '@aquarium/shared';
import { CarcassSupport, FishState } from '@aquarium/sim';
import { describe, expect, it } from 'vitest';
import {
  APPENDAGE_HZ,
  APPENDAGE_RATE,
  APPENDAGE_WRAP_CYCLES,
  curlAboveFloor,
  curledTip,
  floorUnderTail,
  legCyclePhase,
  legSwing,
  MAX_TAIL_CURL,
  PICK_IDLE,
  TAIL_CURL_PEAK,
  TAIL_FLOOR_CLEARANCE_BODY_LENGTHS,
  tailCurl,
  WALK_GAIT,
  WalkState,
  type TailRig,
  type WalkSample,
} from './walk';

const LENGTH = 0.03;

function sample(overrides: Partial<WalkSample> = {}): WalkSample {
  return { speed: 0, state: FishState.Walk, legPhase: 0, flip: 0, attached: 1, ...overrides };
}

function settle(state: WalkState, s: WalkSample, seconds = 8): void {
  for (let t = 0; t < seconds; t += 1 / 60) state.advance(1 / 60, s);
}

describe('tailCurl', () => {
  it('is straight outside a flip and at both of its ends', () => {
    for (const p of [-1, 0, 1, 2, Number.NaN]) expect(tailCurl(p)).toBe(0);
  });

  it('peaks at full flexion and rises then falls monotonically', () => {
    expect(tailCurl(TAIL_CURL_PEAK)).toBeCloseTo(MAX_TAIL_CURL, 9);
    const steps = 200;
    let last = 0;
    for (let i = 1; i < steps; i++) {
      const p = i / steps;
      const curl = tailCurl(p);
      if (p <= TAIL_CURL_PEAK) expect(curl).toBeGreaterThanOrEqual(last);
      else expect(curl).toBeLessThanOrEqual(last);
      last = curl;
    }
  });
});

describe('curlAboveFloor', () => {
  // The cherry shrimp's hinge and standoff from the shipped index, with its tail-fan tip.
  const rig: TailRig = {
    hinge: { y: 0.0002, z: 0.0019 },
    tip: { y: -0.0015, z: -0.0165, share: 1 },
    bodyLength: LENGTH,
  };
  const STANDOFF = 0.0046;
  const FLOOR = 0.1;
  const level = { x: 0, y: 0, z: 0, w: 1 };
  const margin = TAIL_FLOOR_CLEARANCE_BODY_LENGTHS * LENGTH;
  const tipHeight = (curl: number, y: number): number => y + curledTip(rig, curl).y;

  it('turns the tip the way the material does: down and forward', () => {
    const rest = curledTip(rig, 0);
    expect(rest).toEqual({ y: rig.tip.y, z: rig.tip.z });
    const curled = curledTip(rig, MAX_TAIL_CURL);
    expect(curled.y).toBeLessThan(rest.y);
    expect(curled.z).toBeGreaterThan(rest.z);
    const radius = Math.hypot(rig.tip.y - rig.hinge.y, rig.tip.z - rig.hinge.z);
    expect(Math.hypot(curled.y - rig.hinge.y, curled.z - rig.hinge.z)).toBeCloseTo(radius, 12);
  });

  it('cuts a full curl short on the floor, just where the tip meets the sand', () => {
    const y = FLOOR + STANDOFF;
    expect(tipHeight(MAX_TAIL_CURL, y)).toBeLessThan(FLOOR);
    const curl = curlAboveFloor(MAX_TAIL_CURL, rig, 1, { y }, level, FLOOR);
    expect(curl).toBeGreaterThan(0);
    expect(curl).toBeLessThan(MAX_TAIL_CURL);
    expect(tipHeight(curl, y)).toBeGreaterThanOrEqual(FLOOR + margin - 1e-9);
    expect(tipHeight(curl, y)).toBeCloseTo(FLOOR + margin, 5);
  });

  it('lets the whole curl through once the flip has lifted the body clear', () => {
    const y = FLOOR + 0.03;
    expect(curlAboveFloor(MAX_TAIL_CURL, rig, 1, { y }, level, FLOOR)).toBe(MAX_TAIL_CURL);
    expect(curlAboveFloor(0.1, rig, 1, { y: FLOOR + STANDOFF }, level, FLOOR)).toBe(0.1);
  });

  it('scales the rig with the animal', () => {
    const y = FLOOR + 2 * STANDOFF;
    const curl = curlAboveFloor(MAX_TAIL_CURL, rig, 2, { y }, level, FLOOR);
    expect(curl).toBeLessThan(MAX_TAIL_CURL);
    expect(y + 2 * curledTip(rig, curl).y).toBeCloseTo(FLOOR + 2 * margin, 5);
  });

  it('frees the curl on a walker upside down, whose ventral curl lifts the tail', () => {
    const flipped = { x: 0, y: 0, z: 1, w: 0 };
    const y = FLOOR + 0.02;
    expect(curlAboveFloor(MAX_TAIL_CURL, rig, 1, { y }, flipped, FLOOR)).toBe(MAX_TAIL_CURL);
  });

  it('never sinks a tip that rests below the floor any deeper', () => {
    const y = FLOOR + STANDOFF - 0.004;
    const rest = tipHeight(0, y);
    expect(rest).toBeLessThan(FLOOR);
    const curl = curlAboveFloor(MAX_TAIL_CURL, rig, 1, { y }, level, FLOOR);
    expect(curl).toBeLessThan(0.01);
    expect(tipHeight(curl, y)).toBeGreaterThanOrEqual(rest - 1e-9);
  });

  it('passes a straight or negative curl through', () => {
    expect(curlAboveFloor(0, rig, 1, { y: FLOOR }, level, FLOOR)).toBe(0);
    expect(curlAboveFloor(-0.2, rig, 1, { y: FLOOR }, level, FLOOR)).toBe(-0.2);
  });

  describe('floorUnderTail', () => {
    const ROCK_TOP = 0.15;
    const rock: Collider = {
      id: 'rock',
      kind: 'box',
      hard: true,
      center: [0, ROCK_TOP - 0.05, 0],
      halfExtents: [0.05, 0.05, 0.05],
      rotationY: 0,
      rounding: 0,
    };
    const sand = (): number => FLOOR;
    const support = new CarcassSupport([rock]);
    const floorAt = (x: number, z: number, fromY: number): number =>
      support.floorY({ x, y: fromY, z, yaw: 0 }, 0, sand);

    it('clamps a flip on a rock against the rock top, not the sand below', () => {
      const at = { x: 0, y: ROCK_TOP + STANDOFF, z: 0 };
      const floorY = floorUnderTail(MAX_TAIL_CURL, rig, 1, at, level, floorAt);
      expect(floorY).toBeCloseTo(ROCK_TOP, 3);
      expect(curlAboveFloor(MAX_TAIL_CURL, rig, 1, at, level, FLOOR)).toBe(MAX_TAIL_CURL);
      const curl = curlAboveFloor(MAX_TAIL_CURL, rig, 1, at, level, floorY);
      expect(curl).toBeLessThan(MAX_TAIL_CURL);
      expect(tipHeight(curl, at.y)).toBeGreaterThanOrEqual(floorY + margin - 1e-9);
    });

    it('takes the sand for a walker beside the rock', () => {
      const at = { x: 0.08, y: FLOOR + STANDOFF, z: 0 };
      expect(floorUnderTail(MAX_TAIL_CURL, rig, 1, at, level, floorAt)).toBe(FLOOR);
    });

    it('keeps the higher floor of the tip at rest and fully curled', () => {
      const curled = curledTip(rig, MAX_TAIL_CURL);
      const step = (rig.tip.z + curled.z) / 2;
      const ledge = (_x: number, z: number): number => (z > step ? 0.12 : FLOOR);
      const at = { x: 0, y: 0.2, z: 0 };
      expect(floorUnderTail(MAX_TAIL_CURL, rig, 1, at, level, ledge)).toBe(0.12);
      expect(floorUnderTail(0.01, rig, 1, at, level, ledge)).toBe(FLOOR);
    });

    it('looks under the tip where the heading turns it, scaled, from the body height', () => {
      const yaw90 = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
      const at = { x: 0.3, y: 0.2, z: -0.1 };
      const seen: [number, number, number][] = [];
      floorUnderTail(MAX_TAIL_CURL, rig, 2, at, yaw90, (x, z, fromY) => {
        seen.push([x, z, fromY]);
        return FLOOR;
      });
      for (const [i, c] of [0, MAX_TAIL_CURL].entries()) {
        const tip = curledTip(rig, c);
        const [x, z, fromY] = seen[i] ?? [NaN, NaN, NaN];
        expect(x).toBeCloseTo(at.x + 2 * tip.z, 9);
        expect(z).toBeCloseTo(at.z, 9);
        expect(fromY).toBe(at.y);
      }
    });
  });
});

describe('legSwing', () => {
  it('sweeps forward to back while planted and stays on the ground', () => {
    expect(legSwing(0)).toEqual({ sweep: 1, lift: 0 });
    const mid = legSwing(WALK_GAIT.dutyFactor / 2);
    expect(mid.sweep).toBeCloseTo(0, 9);
    expect(mid.lift).toBe(0);
  });

  it('lifts the foot only during the swing, highest halfway', () => {
    const half = WALK_GAIT.dutyFactor + (1 - WALK_GAIT.dutyFactor) / 2;
    expect(legSwing(half).lift).toBeCloseTo(1, 9);
    expect(legSwing(half).sweep).toBeCloseTo(0, 9);
  });

  it('is continuous through touchdown, lift-off and the wrap', () => {
    const e = 1e-6;
    for (const u of [WALK_GAIT.dutyFactor, 1]) {
      const before = legSwing(u - e);
      const after = legSwing(u + e);
      expect(after.sweep).toBeCloseTo(before.sweep, 4);
      expect(after.lift).toBeCloseTo(before.lift, 4);
    }
  });
});

describe('legCyclePhase', () => {
  it('puts the two legs of a pair half a cycle apart', () => {
    for (let pair = 0; pair < 5; pair++) {
      const left = legCyclePhase(0.3, pair * 2);
      const right = legCyclePhase(0.3, pair * 2 + 1);
      expect((right - left + 1) % 1).toBeCloseTo(0.5, 9);
    }
  });

  it('lags each pair behind the previous by the pair lag, and stays in 0..1', () => {
    for (const legPhase of [0, 0.1, 0.95, 3.4, -0.2]) {
      for (let leg = 0; leg < 10; leg++) {
        const u = legCyclePhase(legPhase, leg);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(1);
      }
      const lag = (legCyclePhase(legPhase, 2) - legCyclePhase(legPhase, 4) + 1) % 1;
      expect(lag).toBeCloseTo(WALK_GAIT.pairLag, 9);
    }
  });
});

describe('appendage clock', () => {
  it('completes whole cycles of every rate when it wraps', () => {
    for (const rate of Object.values(APPENDAGE_RATE)) {
      const cycles = rate * APPENDAGE_WRAP_CYCLES;
      expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(1e-9);
    }
  });

  it('advances at the appendage rate and wraps inside its period', () => {
    const state = new WalkState(LENGTH, 0);
    state.advance(0.25, sample());
    expect(state.clock).toBeCloseTo(2 * Math.PI * APPENDAGE_HZ * 0.25, 9);
    for (let i = 0; i < 100; i++) state.advance(0.37, sample());
    expect(state.clock).toBeGreaterThanOrEqual(0);
    expect(state.clock).toBeLessThan(2 * Math.PI * APPENDAGE_WRAP_CYCLES);
  });
});

describe('WalkState', () => {
  it('takes the leg phase and the flip straight from the sim', () => {
    const state = new WalkState(LENGTH, 0);
    state.advance(1 / 30, sample({ legPhase: 2.75, flip: TAIL_CURL_PEAK }));
    expect(state.legPhase).toBeCloseTo(0.75, 9);
    expect(state.curl).toBeCloseTo(MAX_TAIL_CURL, 9);
  });

  it('keeps the legs still at a standstill and strides fully at walking pace', () => {
    const state = new WalkState(LENGTH, 0);
    settle(state, sample({ speed: 0 }));
    expect(state.stride).toBeCloseTo(0, 6);
    settle(state, sample({ speed: LENGTH }));
    expect(state.stride).toBeCloseTo(1, 6);
  });

  it('eases into a stride instead of snapping', () => {
    const state = new WalkState(LENGTH, 0);
    state.advance(1 / 60, sample({ speed: LENGTH }));
    expect(state.stride).toBeGreaterThan(0);
    expect(state.stride).toBeLessThan(0.5);
  });

  it('paddles and tucks the legs away when it lets go of the ground', () => {
    const state = new WalkState(LENGTH, 0);
    settle(state, sample({ speed: LENGTH }));
    settle(state, sample({ speed: LENGTH, attached: 0, state: FishState.Fall }));
    expect(state.paddle).toBeCloseTo(1, 6);
    expect(state.stride).toBeCloseTo(0, 6);
    expect(state.pick).toBeCloseTo(0, 6);
    settle(state, sample());
    expect(state.paddle).toBeCloseTo(0, 6);
  });

  it('picks harder while picking and grazes lightly otherwise', () => {
    const state = new WalkState(LENGTH, 0);
    expect(state.pick).toBe(PICK_IDLE);
    settle(state, sample({ state: FishState.Pick }));
    expect(state.pick).toBeCloseTo(1, 6);
    settle(state, sample());
    expect(state.pick).toBeCloseTo(PICK_IDLE, 6);
  });

  it('displays only while dancing', () => {
    const state = new WalkState(LENGTH, 0);
    settle(state, sample({ state: FishState.Dance }));
    expect(state.dance).toBeCloseTo(1, 6);
    settle(state, sample());
    expect(state.dance).toBeCloseTo(0, 6);
  });

  it('holds still on a zero step', () => {
    const state = new WalkState(LENGTH, 1);
    state.advance(0, sample({ speed: LENGTH, state: FishState.Pick }));
    expect(state.clock).toBe(1);
    expect(state.stride).toBe(0);
    expect(state.pick).toBe(PICK_IDLE);
  });

  it('rejects a bad length or step', () => {
    expect(() => new WalkState(0, 0)).toThrow(RangeError);
    const state = new WalkState(LENGTH, 0);
    expect(() => state.advance(-1, sample())).toThrow(RangeError);
    expect(() => state.advance(Number.NaN, sample())).toThrow(RangeError);
  });
});
