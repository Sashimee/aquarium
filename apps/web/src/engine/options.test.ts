import { describe, expect, it } from 'vitest';
import { parseEngineOptions } from './options';

describe('parseEngineOptions', () => {
  it('defaults to auto backend, probed tier and adaptation', () => {
    expect(parseEngineOptions('')).toEqual({
      backend: 'auto',
      tier: null,
      adaptive: true,
      clock: null,
      stats: false,
      tankSize: 'standard',
      frameRate: null,
      pixelRatio: null,
    });
  });

  it('reads the forced WebGL fallback flag', () => {
    expect(parseEngineOptions('?backend=webgl').backend).toBe('webgl');
    expect(parseEngineOptions('?backend=webgpu').backend).toBe('webgpu');
  });

  it('a pinned tier disables adaptation', () => {
    expect(parseEngineOptions('?tier=ultra')).toEqual({
      backend: 'auto',
      tier: 'ultra',
      adaptive: false,
      clock: null,
      stats: false,
      tankSize: 'standard',
      frameRate: null,
      pixelRatio: null,
    });
    expect(parseEngineOptions('?tier=low&adaptive=1').adaptive).toBe(false);
  });

  it('adaptive=0 keeps the probe but stops adaptation', () => {
    expect(parseEngineOptions('?adaptive=0')).toEqual({
      backend: 'auto',
      tier: null,
      adaptive: false,
      clock: null,
      stats: false,
      tankSize: 'standard',
      frameRate: null,
      pixelRatio: null,
    });
  });

  it('pins the tank clock to a time of day', () => {
    expect(parseEngineOptions('?clock=22:15').clock).toBe(22 * 60 + 15);
    expect(parseEngineOptions('?clock=night').clock).toBe(0);
  });

  it('turns the stats readout on only for stats=1', () => {
    expect(parseEngineOptions('?stats=1').stats).toBe(true);
    expect(parseEngineOptions('?stats=0').stats).toBe(false);
    expect(parseEngineOptions('?tier=low&stats=1')).toMatchObject({ tier: 'low', stats: true });
  });

  it('reads the demo tank size, the standard tank by default', () => {
    expect(parseEngineOptions('?size=nano30').tankSize).toBe('nano30');
    expect(parseEngineOptions('?size=long300').tankSize).toBe('long300');
    expect(parseEngineOptions('?size=standard').tankSize).toBe('standard');
  });

  it('reads the frame rate and pixel ratio overrides', () => {
    expect(parseEngineOptions('?fps=display')).toMatchObject({ frameRate: 'display' });
    expect(parseEngineOptions('?fps=capped')).toMatchObject({ frameRate: 'capped' });
    expect(parseEngineOptions('?dpr=device')).toMatchObject({ pixelRatio: 'device' });
    expect(parseEngineOptions('?dpr=capped&fps=display')).toMatchObject({
      frameRate: 'display',
      pixelRatio: 'capped',
    });
  });

  it('rejects unknown values with a message naming the valid ones', () => {
    expect(() => parseEngineOptions('?size=huge')).toThrow(/nano30, standard, std200, long300/);
    expect(() => parseEngineOptions('?backend=vulkan')).toThrow(/auto, webgpu, webgl/);
    expect(() => parseEngineOptions('?tier=extreme')).toThrow(/low, medium, high, ultra/);
    expect(() => parseEngineOptions('?adaptive=yes')).toThrow(/0 or 1/);
    expect(() => parseEngineOptions('?stats=yes')).toThrow(/0 or 1/);
    expect(() => parseEngineOptions('?clock=noon')).toThrow(/HH:MM, day or night/);
    expect(() => parseEngineOptions('?fps=144')).toThrow(/capped, display/);
    expect(() => parseEngineOptions('?dpr=2')).toThrow(/capped, device/);
  });
});
