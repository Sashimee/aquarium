import { describe, expect, it } from 'vitest';
import { speciesInput } from './species';

describe('speciesInput', () => {
  it('knows the freshwater and reef species a saved tank can hold', () => {
    for (const id of ['neon-tetra', 'betta', 'ocellaris-clownfish', 'blue-tang', 'royal-gramma']) {
      const input = speciesInput(id);
      expect(input?.id, id).toBe(id);
      expect(input?.locomotion.bodyLengthM, id).toBeGreaterThan(0);
      expect(input?.lifecycle.diet.length, id).toBeGreaterThan(0);
    }
  });

  it('is undefined for a species this build has no content for', () => {
    expect(speciesInput('coelacanth')).toBeUndefined();
  });
});
