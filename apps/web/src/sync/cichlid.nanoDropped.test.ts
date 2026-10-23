import { describe, expect, it, vi } from 'vitest';
import { tankFixture } from './fixtures';

vi.mock('../scene/preset', () => {
  const rock = { assetId: 'malawi-rock-07', position: [0, 0, 0], rotationY: 0, scale: 1 };
  const shell = { ...rock, assetId: 'neothauma-shell' };
  return { loadPreset: () => ({ decor: [rock, rock, rock, rock, shell, shell, shell, shell] }) };
});

const { shelterCount } = await import('./cichlid');

describe('shelterCount when the nano tank drops every shelter', () => {
  it('counts none in a nano but all of them in a standard tank', () => {
    expect(shelterCount(tankFixture({ biome: 'cichlid', size: 'standard' }))).toBe(4);
    expect(shelterCount(tankFixture({ biome: 'cichlid', size: 'nano30' }))).toBe(0);
  });
});
