import { describe, expect, it } from 'vitest';
import { parseEngineOptions } from './options';

describe('parseEngineOptions', () => {
  it('defaults to auto backend, probed tier and adaptation', () => {
    expect(parseEngineOptions('')).toEqual({ backend: 'auto', tier: null, adaptive: true });
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
    });
    expect(parseEngineOptions('?tier=low&adaptive=1').adaptive).toBe(false);
  });

  it('adaptive=0 keeps the probe but stops adaptation', () => {
    expect(parseEngineOptions('?adaptive=0')).toEqual({
      backend: 'auto',
      tier: null,
      adaptive: false,
    });
  });

  it('rejects unknown values with a message naming the valid ones', () => {
    expect(() => parseEngineOptions('?backend=vulkan')).toThrow(/auto, webgpu, webgl/);
    expect(() => parseEngineOptions('?tier=extreme')).toThrow(/low, medium, high, ultra/);
    expect(() => parseEngineOptions('?adaptive=yes')).toThrow(/0 or 1/);
  });
});
