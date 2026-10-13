import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBiome, parseSceneOptions, withBiome } from './options';

afterEach(() => vi.restoreAllMocks());

describe('parseSceneOptions', () => {
  it('defaults to no overlay', () => {
    expect(parseSceneOptions('')).toEqual({ colliders: false });
  });

  it('enables the overlay with ?colliders=1', () => {
    expect(parseSceneOptions('?colliders=1')).toEqual({ colliders: true });
  });

  it('warns and ignores any other value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseSceneOptions('?colliders=yes')).toEqual({ colliders: false });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('parseBiome', () => {
  it('defaults to freshwater', () => {
    expect(parseBiome('')).toBe('freshwater');
  });

  it('selects the reef with ?biome=reef', () => {
    expect(parseBiome('?backend=webgl&biome=reef')).toBe('reef');
  });

  it('warns and falls back to freshwater for an unknown biome', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseBiome('?biome=lake')).toBe('freshwater');
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('withBiome', () => {
  it('adds the biome to an empty query', () => {
    expect(withBiome('', 'reef')).toBe('?biome=reef');
  });

  it('replaces an existing biome and keeps the other parameters', () => {
    expect(withBiome('?backend=webgl&biome=reef&colliders=1', 'freshwater')).toBe(
      '?backend=webgl&biome=freshwater&colliders=1',
    );
  });

  it('round-trips through parseBiome', () => {
    expect(parseBiome(withBiome('?biome=lake', 'reef'))).toBe('reef');
  });
});
