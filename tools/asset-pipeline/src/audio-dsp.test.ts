import { describe, expect, it } from 'vitest';
import {
  AUDIO_SAMPLE_RATE,
  fadeIn,
  fadeOut,
  integratedLoudness,
  linearToDb,
  loopCrossfade,
  normaliseLoudness,
  peakOf,
  stationaryStart,
  trimSilence,
} from './audio-dsp.ts';

const RATE = AUDIO_SAMPLE_RATE;

function sine(seconds: number, hz: number, amplitude: number): Float32Array {
  return Float32Array.from(
    { length: Math.round(seconds * RATE) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE),
  );
}

describe('integratedLoudness', () => {
  it('measures a full-scale 997 Hz sine at the BS.1770 reference level', () => {
    expect(integratedLoudness(sine(3, 997, 1))).toBeCloseTo(-3.01, 1);
  });

  it('drops by 6 dB when the amplitude halves', () => {
    const loud = integratedLoudness(sine(2, 440, 0.5));
    const quiet = integratedLoudness(sine(2, 440, 0.25));
    expect(loud - quiet).toBeCloseTo(6.02, 2);
  });

  it('ignores a silent tail through the gate', () => {
    const tone = sine(2, 440, 0.3);
    const padded = new Float32Array(tone.length + 4 * RATE);
    padded.set(tone);
    expect(integratedLoudness(padded)).toBeCloseTo(integratedLoudness(tone), 0);
  });

  it('measures a clip shorter than one gating block as a single block', () => {
    expect(integratedLoudness(sine(0.1, 997, 1))).toBeGreaterThan(-5);
  });

  it('reports silence as -Infinity and rejects an empty signal', () => {
    expect(integratedLoudness(new Float32Array(2 * RATE))).toBe(-Infinity);
    expect(() => integratedLoudness(new Float32Array(0))).toThrow('empty');
  });
});

describe('normaliseLoudness', () => {
  it('lands on the target loudness', () => {
    const { samples, peakLimited } = normaliseLoudness(sine(3, 440, 0.1), -23, -1);
    expect(integratedLoudness(samples)).toBeCloseTo(-23, 1);
    expect(peakLimited).toBe(false);
  });

  it('backs off to the peak ceiling when the target would clip', () => {
    const spiky = sine(1, 440, 0.01);
    spiky[100] = 0.9;
    const { samples, peakLimited } = normaliseLoudness(spiky, -6, -1);
    expect(peakLimited).toBe(true);
    expect(linearToDb(peakOf(samples))).toBeCloseTo(-1, 3);
    expect(integratedLoudness(samples)).toBeLessThan(-6);
  });

  it('refuses a silent clip', () => {
    expect(() => normaliseLoudness(new Float32Array(RATE), -23, -1)).toThrow('silent');
  });
});

describe('trimSilence', () => {
  it('keeps the audible span plus the margin', () => {
    const samples = new Float32Array(1000);
    samples[300] = 0.5;
    samples[600] = -0.5;
    const trimmed = trimSilence(samples, -50, 10);
    expect(trimmed.length).toBe(321);
    expect(trimmed[10]).toBe(0.5);
  });

  it('clamps the margin at the clip edges', () => {
    const samples = new Float32Array(50);
    samples[0] = 1;
    samples[49] = 1;
    expect(trimSilence(samples, -50, 100).length).toBe(50);
  });

  it('throws on a clip with nothing above the threshold', () => {
    expect(() => trimSilence(new Float32Array(100), -50, 0)).toThrow('silent');
  });
});

describe('fades', () => {
  it('start and end at silence without touching the middle or the input', () => {
    const ones = new Float32Array(100).fill(1);
    const inFaded = fadeIn(ones, 10);
    expect(inFaded[0]).toBeLessThan(0.01);
    expect(inFaded[9]).toBeGreaterThan(0.95);
    expect(inFaded[50]).toBe(1);
    const outFaded = fadeOut(ones, 10);
    expect(outFaded[99]).toBeLessThan(0.01);
    expect(outFaded[50]).toBe(1);
    expect(ones[0]).toBe(1);
  });
});

describe('loopCrossfade', () => {
  it('shortens the segment by the fade length', () => {
    expect(loopCrossfade(new Float32Array(1000), 100).length).toBe(900);
  });

  it('joins the loop end to its start no more abruptly than the source moves', () => {
    const loop = loopCrossfade(sine(2, 100, 0.5), RATE / 4);
    const maxStep = 0.5 * 2 * Math.PI * (100 / RATE);
    expect(Math.abs(loop[0]! - loop[loop.length - 1]!)).toBeLessThanOrEqual(maxStep * 1.5);
  });

  it('removes the jump a plain cut of an unlike start and end would make', () => {
    const segment = Float32Array.from({ length: 2000 }, (_, i) => i / 2000);
    const loop = loopCrossfade(segment, 400);
    const plainCutJump = Math.abs(segment[0]! - segment[1599]!);
    expect(plainCutJump).toBeGreaterThan(0.7);
    expect(Math.abs(loop[0]! - loop[loop.length - 1]!)).toBeLessThan(0.01);
  });

  it('holds constant power through the fade for uncorrelated noise', () => {
    let seed = 1;
    const noise = Float32Array.from({ length: 40000 }, () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 2147483648 - 1;
    });
    const loop = loopCrossfade(noise, 10000);
    const rms = (from: number, to: number) =>
      Math.sqrt(loop.slice(from, to).reduce((s, v) => s + v * v, 0) / (to - from));
    expect(rms(0, 10000)).toBeCloseTo(rms(15000, 30000), 1);
  });

  it('rejects a fade that does not fit', () => {
    expect(() => loopCrossfade(new Float32Array(100), 60)).toThrow('does not fit');
    expect(() => loopCrossfade(new Float32Array(100), 0)).toThrow('does not fit');
  });
});

describe('stationaryStart', () => {
  it('avoids a loud event and picks the steady stretch', () => {
    const samples = sine(10, 200, 0.1);
    samples.fill(0.9, 1 * RATE, 3 * RATE);
    expect(stationaryStart(samples, 3 * RATE)).toBeGreaterThanOrEqual(3 * RATE);
  });

  it('throws when the source is shorter than the window', () => {
    expect(() => stationaryStart(sine(1, 200, 0.1), 3 * RATE)).toThrow('shorter than');
  });
});
