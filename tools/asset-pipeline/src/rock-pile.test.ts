import { describe, expect, it } from 'vitest';
import type { Part } from './parts.ts';
import { composeRockPile, placeRock, type RockPileRecipe } from './rock-pile.ts';

function box(): Part {
  return {
    positions: Float32Array.from([-0.5, 0, -0.25, 0.5, 0, -0.25, 0.5, 0.4, 0.25, -0.5, 0.4, 0.25]),
    normals: Float32Array.from([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
    uvs: new Float32Array(8),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    material: 'rock',
    extra: {},
  };
}

describe('placeRock', () => {
  it('leaves the part alone at the identity placement', () => {
    const placed = placeRock(box(), { recipeId: 'a', x: 0, z: 0, y: 0, yawDeg: 0, scale: 1 });
    expect([...placed.positions]).toEqual([...box().positions]);
  });

  it('rotates normals with the yaw and keeps them unit length', () => {
    const placed = placeRock(box(), { recipeId: 'a', x: 0, z: 0, y: 0, yawDeg: 90, scale: 2 });
    expect(placed.normals[0]).toBeCloseTo(0);
    expect(placed.normals[2]).toBeCloseTo(-1);
    expect(
      Math.hypot(placed.normals[0] ?? 0, placed.normals[1] ?? 0, placed.normals[2] ?? 0),
    ).toBeCloseTo(1);
  });

  it('scales about the origin before translating', () => {
    const placed = placeRock(box(), { recipeId: 'a', x: 1, z: -2, y: 0.5, yawDeg: 0, scale: 2 });
    expect(placed.positions[0]).toBeCloseTo(0);
    expect(placed.positions[1]).toBeCloseTo(0.5);
    expect(placed.positions[2]).toBeCloseTo(-2.5);
  });
});

describe('composeRockPile', () => {
  const loaded = new Map([['box', { parts: [box()], materials: [] }]]);

  it('re-centres the pile so its base sits on the origin', () => {
    const recipe: RockPileRecipe = {
      id: 'pile',
      modifications: [],
      placements: [
        { recipeId: 'box', x: 3, z: 3, y: 0, yawDeg: 0, scale: 1 },
        { recipeId: 'box', x: 3.4, z: 3, y: 0.4, yawDeg: 0, scale: 1 },
      ],
    };
    const { parts } = composeRockPile(recipe, loaded);
    expect(parts).toHaveLength(2);
    let minY = Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const part of parts)
      for (let i = 0; i < part.positions.length; i += 3) {
        minY = Math.min(minY, part.positions[i + 1] ?? 0);
        minX = Math.min(minX, part.positions[i] ?? 0);
        maxX = Math.max(maxX, part.positions[i] ?? 0);
      }
    expect(minY).toBeCloseTo(0);
    expect((minX + maxX) / 2).toBeCloseTo(0);
  });

  it('fails loudly on an unknown rock', () => {
    expect(() =>
      composeRockPile(
        {
          id: 'pile',
          modifications: [],
          placements: [{ recipeId: 'missing', x: 0, z: 0, y: 0, yawDeg: 0, scale: 1 }],
        },
        loaded,
      ),
    ).toThrow(/no rock loaded for missing/);
  });
});
