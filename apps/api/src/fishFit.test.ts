import { readFileSync } from 'node:fs';
import { speciesContentSchema, tankSizeSchema, tankSpaceOfSize } from '@aquarium/shared';
import { World, maxFishLengthM } from '@aquarium/sim';
import { describe, expect, it } from 'vitest';
import { adultLengthRefusal, tankMaxFishLengthM } from './fishFit.ts';

const blueTang = speciesContentSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../content/species/blue-tang.json', import.meta.url), 'utf8'),
  ),
);

describe('tankMaxFishLengthM', () => {
  it.each(tankSizeSchema.options)('is strictly below the sim limit for %s', (size) => {
    const exact = maxFishLengthM(tankSpaceOfSize(size));
    expect(tankMaxFishLengthM(size)).toBeLessThan(exact);
    expect(exact - tankMaxFishLengthM(size)).toBeLessThan(1e-4);
  });

  it('keeps the numbers migration 0034 clamps to', () => {
    expect(tankSizeSchema.options.map(tankMaxFishLengthM)).toEqual([
      0.2168, 0.3518, 0.3643, 0.3116,
    ]);
  });

  it.each(tankSizeSchema.options)('is a length the sim accepts in %s', (size) => {
    expect(
      () =>
        new World({
          seed: 1,
          space: tankSpaceOfSize(size),
          species: [blueTang],
          fish: [{ id: 'a', species: 'blue-tang', bodyLengthM: tankMaxFishLengthM(size) }],
        }),
    ).not.toThrow();
  });
});

describe('adultLengthRefusal', () => {
  const tang = { commonName: 'Blue tang', lifecycle: { maxSizeM: 0.267 } };
  const nano = { size: 'nano30', quarantine: false } as const;

  it('words the refusal for a quarantine tank', () => {
    expect(adultLengthRefusal(tang, { ...nano, quarantine: true })).toBe(
      'Blue tang grows to 27 cm, but this tank only holds fish up to 21 cm. A quarantine tank is too small for it, so it cannot go there.',
    );
  });

  it('points a display tank at a bigger one', () => {
    expect(adultLengthRefusal(tang, nano)).toMatch(/Choose a bigger tank\.$/);
  });

  it('refuses a fish exactly at the sim limit and accepts one at the table value', () => {
    const exact = maxFishLengthM(tankSpaceOfSize('nano30'));
    expect(adultLengthRefusal({ ...tang, lifecycle: { maxSizeM: exact } }, nano)).toBeDefined();
    expect(adultLengthRefusal({ ...tang, lifecycle: { maxSizeM: 0.2168 } }, nano)).toBeUndefined();
  });
});
