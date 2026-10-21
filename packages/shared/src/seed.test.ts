import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seedOf } from './seed.js';

describe('seedOf', () => {
  it.each([
    ['tank', '00000000-0000-4000-8000-000000000000', 1204850214],
    ['fish', 'a', 71860269],
    ['tank', '', 658132898],
    ['fish', 'b3b6d9a2-5c1e-4f7a-9d0e-123456789abc', 3427039300],
    ['tank', 'x'.repeat(100), 1648975374],
    ['fish', 'é🐟', 3599379907],
  ] as const)('%s:%j is pinned to the server SHA-256 value', (label, id, expected) => {
    expect(seedOf(label, id)).toBe(expected);
  });

  it('matches node SHA-256 across every padding boundary', () => {
    for (let n = 0; n < 200; n++) {
      const id = 'y'.repeat(n);
      const expected = createHash('sha256').update(`tank:${id}`).digest().readUInt32BE(0);
      expect(seedOf('tank', id), `length ${n}`).toBe(expected);
    }
  });
});
