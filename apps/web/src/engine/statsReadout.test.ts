import { describe, expect, it } from 'vitest';
import type { EngineStats } from './events';
import { formatPending, formatReadout, readStats, type ReadoutSource } from './statsReadout';

const source: ReadoutSource = {
  backend: 'webgl2',
  quality: { adaptive: true },
  renderer: { getPixelRatio: () => 1.5, domElement: { width: 590, height: 1278 } },
};

const stats: EngineStats = {
  fps: 29.94,
  frameMs: 33.399,
  gpuMs: null,
  drawCalls: 142,
  triangles: 1234567,
  tier: 'medium',
};

describe('readStats', () => {
  it('reports the render pixel ratio actually used next to the device ratio', () => {
    expect(readStats(source, stats, 3)).toEqual({
      backend: 'webgl2',
      tier: 'medium',
      adaptive: true,
      fps: '29.9',
      frame: '33.40',
      gpu: 'n/a',
      gpuSpansFrames: false,
      dpr: '3.00',
      pixelRatio: '1.50',
      canvas: '590x1278',
      draws: 142,
      triangles: 1234567,
    });
  });

  it('shows gpu time when the backend can measure it', () => {
    const r = readStats(source, { ...stats, gpuMs: 7.125 }, 1);
    expect(r.gpu).toBe('7.13');
    expect(r.gpuSpansFrames).toBe(false);
  });

  it('flags a gpu time longer than the frame interval as spanning frames', () => {
    const r = readStats(source, { ...stats, frameMs: 16.7, gpuMs: 45.4 }, 3);
    expect(r.gpuSpansFrames).toBe(true);
    expect(formatReadout(r).split('\n')[2]).toBe('gpu 45.40 ms (spans frames)');
  });

  it('accepts a gpu time up to the frame interval on a GPU-bound device', () => {
    expect(readStats(source, { ...stats, frameMs: 33.4, gpuMs: 33 }, 1).gpuSpansFrames).toBe(false);
  });
});

describe('formatReadout', () => {
  it('fits every field on short lines for a phone screen', () => {
    const text = formatReadout(readStats(source, stats, 3));
    expect(text).toBe(
      [
        'webgl2  medium  adaptive on',
        'fps 29.9  frame 33.40 ms',
        'gpu n/a ms',
        'dpr 3.00  render 1.50',
        'canvas 590x1278',
        'draws 142  tris 1,234,567',
      ].join('\n'),
    );
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(30);
  });

  it('says when adaptation is off', () => {
    const r = readStats({ ...source, quality: { adaptive: false } }, stats, 1);
    expect(formatReadout(r).split('\n')[0]).toBe('webgl2  medium  adaptive off');
  });
});

describe('formatPending', () => {
  it('opens with the same line the first readout will replace it with', () => {
    const r = readStats(source, stats, 3);
    const pending = formatPending(r).split('\n');
    expect(pending[0]).toBe(formatReadout(r).split('\n')[0]);
    expect(pending[1]).toBe('waiting for frames');
  });
});
