import { describe, expect, it } from 'vitest';
import {
  containsBlockedWord,
  handleResponseSchema,
  handleSchema,
  setHandleRequestSchema,
} from './wordFilter.js';

describe('word filter', () => {
  it.each([
    'scunthorpe',
    'dickens',
    'class',
    'assassin',
    'cocktail',
    'essex',
    'analyst',
    'fish_it',
    'goldfish_it',
    'push_it',
    'therapist',
    'nazir',
    'fire_retardant',
    'sniggle',
    'mishit',
  ])('lets the innocent word %s through', (word) => {
    expect(containsBlockedWord(word)).toBe(false);
  });

  it.each([
    'fuck',
    'f_u_c_k',
    'b_i_t_c_h',
    'sh1t',
    'b1tch',
    'n4zi',
    'ass',
    'a_s_s',
    'asshat',
    'big dick',
    'p0rn',
  ])('blocks %s, including leet and spacing tricks', (word) => {
    expect(containsBlockedWord(word)).toBe(true);
  });
});

describe('handle', () => {
  it('does not re-run the filter or the reserved list on stored handles', () => {
    expect(handleResponseSchema.safeParse({ handle: 'admin' }).success).toBe(true);
    expect(handleResponseSchema.safeParse({ handle: 'Admin' }).success).toBe(false);
    expect(handleResponseSchema.safeParse({ handle: null }).success).toBe(true);
  });

  it.each(['nemo', 'reef_fan_99', 'abc'])('accepts %s', (handle) => {
    expect(handleSchema.safeParse(handle).success).toBe(true);
  });

  it.each([
    'ab',
    'Nemo',
    '9lives',
    '_nemo',
    'has space',
    'a'.repeat(21),
    'émile',
    'admin',
    'support',
    'root',
    'null',
    'devfish',
    'fuck_you',
    'sh1thead',
  ])('rejects %s', (handle) => {
    expect(handleSchema.safeParse(handle).success).toBe(false);
  });

  it('rejects unknown request fields', () => {
    expect(setHandleRequestSchema.safeParse({ handle: 'nemo', extra: 1 }).success).toBe(false);
  });
});
