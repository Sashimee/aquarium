import { describe, expect, it } from 'vitest';
import { LOFT_FISH_RECIPES, loftFishPart } from './loft-fish.ts';
import { sideProjection } from './loft.ts';

type Point = [number, number];

/** Outline of the fish body in the banggai photo crop, traced by hand; fins excluded. */
const BANGGAI_TOP: Point[] = [
  [130, 1040],
  [160, 990],
  [210, 950],
  [250, 910],
  [300, 875],
  [350, 845],
  [400, 825],
  [450, 818],
  [520, 800],
  [600, 790],
  [680, 782],
  [750, 795],
  [850, 830],
  [950, 875],
  [1050, 890],
  [1150, 885],
];
const BANGGAI_BOTTOM: Point[] = [
  [105, 1100],
  [130, 1160],
  [170, 1220],
  [230, 1270],
  [300, 1310],
  [380, 1330],
  [450, 1345],
  [550, 1335],
  [600, 1330],
  [700, 1310],
  [800, 1270],
  [870, 1230],
  [950, 1140],
  [1050, 1090],
  [1150, 1065],
];
const OUTLINE: Point[] = [...BANGGAI_TOP, ...[...BANGGAI_BOTTOM].reverse()];
const OUTLINE_X_MIN = 125;
const OUTLINE_X_MAX = 1150;

const at = <T>(items: ArrayLike<T>, i: number): T => {
  const v = items[i];
  if (v === undefined) throw new Error(`index ${i} out of range`);
  return v;
};

function inside(polygon: Point[], [x, y]: Point): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = at(polygon, i);
    const [xj, yj] = at(polygon, j);
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

describe('banggai photo projection', () => {
  const recipe = LOFT_FISH_RECIPES.find((r) => r.id === 'banggai-cardinalfish');
  if (!recipe) throw new Error('banggai recipe missing');
  const source = recipe.texture;
  if (source.kind !== 'photo') throw new Error('banggai must use a photo texture');
  const first = at(recipe.spec.sections, 0);
  const last = at(recipe.spec.sections, recipe.spec.sections.length - 1);
  const project = sideProjection({
    standardLengthM: 1,
    snoutY: (first.top + first.bottom) / 2,
    tailY: (last.top + last.bottom) / 2,
    snoutPixel: source.snoutPixel,
    tailPixel: source.tailPixel,
    crop: source.crop,
  });
  const part = loftFishPart(recipe, 1, project);

  const RING = 24;
  const SECTIONS = 48;
  const TOP_SLOT = RING / 4;
  const BOTTOM_SLOT = (3 * RING) / 4;

  it('keeps the dorsal and ventral body outline on the fish, not the photo background', () => {
    const outside: string[] = [];
    for (let s = 0; s < SECTIONS; s++)
      for (const slot of [TOP_SLOT, BOTTOM_SLOT]) {
        const v = s * RING + slot;
        const x = at(part.uvs, v * 2) * source.crop.width;
        const y = at(part.uvs, v * 2 + 1) * source.crop.height;
        if (x < OUTLINE_X_MIN || x > OUTLINE_X_MAX) continue;
        if (!inside(OUTLINE, [x, y]))
          outside.push(
            `${slot === TOP_SLOT ? 'top' : 'bottom'} s${s} at ${x.toFixed(0)},${y.toFixed(0)}`,
          );
      }
    expect(outside).toEqual([]);
  });
});
