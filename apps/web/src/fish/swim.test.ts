import { describe, expect, it } from 'vitest';
import {
  amplitudeScale,
  envelopeAt,
  IDLE_AMPLITUDE,
  IDLE_TAIL_BEAT_HZ,
  MAX_BEND,
  MAX_TAIL_BEAT_HZ,
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
    expect(amplitudeScale(0, 0.05)).toBe(IDLE_AMPLITUDE);
    expect(amplitudeScale(0.075, 0.05)).toBe(1);
    expect(amplitudeScale(5, 0.05)).toBe(1);
  });

  it('rises monotonically in between', () => {
    const samples = [0, 0.01, 0.02, 0.04, 0.06, 0.075].map((u) => amplitudeScale(u, 0.05));
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
    state.advance(0.1, { speed: 0.12, yawRate: 0 });
    expect(state.frequency).toBeCloseTo(5.625, 6);
    expect(state.phase).toBeCloseTo((TAU * 0.5625) % TAU, 6);
    for (let i = 0; i < 100; i++) state.advance(0.033, { speed: 0.12, yawRate: 0 });
    expect(state.phase).toBeGreaterThanOrEqual(0);
    expect(state.phase).toBeLessThan(TAU);
    expect(state.finPhase).toBeLessThan(TAU);
  });

  it('beats the pectorals at their idle rate while hovering', () => {
    const state = new SwimState(0.12, 0.3, SWIM_MODES.labriform, 0);
    state.advance(0.1, { speed: 0, yawRate: 0 });
    expect(state.finPhase).toBeCloseTo(TAU * SWIM_MODES.labriform.pectoralIdleHz * 0.1, 6);
  });

  it('eases the bend towards the turn instead of snapping', () => {
    const state = new SwimState(0.05, 0.3, SWIM_MODES.subcarangiform, 0);
    const target = turnCurvature(1, 0.1, 0.05);
    state.advance(0.02, { speed: 0.1, yawRate: 1 });
    expect(state.curvature).toBeGreaterThan(0);
    expect(state.curvature).toBeLessThan(target);
    for (let i = 0; i < 60; i++) state.advance(0.02, { speed: 0.1, yawRate: 1 });
    expect(state.curvature).toBeCloseTo(target, 3);
  });

  it('leaves the phase alone for a zero step and rejects negative ones', () => {
    const state = new SwimState(0.05, 0.3, SWIM_MODES.carangiform, 1);
    state.advance(0, { speed: 0.1, yawRate: 0 });
    expect(state.phase).toBe(1);
    expect(() => state.advance(-0.01, { speed: 0.1, yawRate: 0 })).toThrow(RangeError);
    expect(() => state.advance(Number.NaN, { speed: 0.1, yawRate: 0 })).toThrow(RangeError);
  });

  it('rejects a non-positive length', () => {
    expect(() => new SwimState(0, 0.3, SWIM_MODES.carangiform, 0)).toThrow(RangeError);
  });
});
