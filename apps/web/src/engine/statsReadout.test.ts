import { describe, expect, it } from 'vitest';
import type { EngineStats } from './events';
import { formatReadout, readStats, type ReadoutSource } from './statsReadout';

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
      dpr: '3.00',
      pixelRatio: '1.50',
      canvas: '590x1278',
      draws: 142,
      triangles: 1234567,
    });
  });

  it('shows gpu time when the backend can measure it', () => {
    expect(readStats(source, { ...stats, gpuMs: 7.125 }, 1).gpu).toBe('7.13');
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
