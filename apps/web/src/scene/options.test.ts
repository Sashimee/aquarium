import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSceneOptions } from './options';

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
