import { describe, expect, it } from 'vitest';
import { apiError } from './fixtures';
import { IntentKeys, newIdempotencyKey, outcomeUnknown } from './intentKeys';
import { idempotencyKeySchema } from '@aquarium/shared';

function counter() {
  let n = 0;
  return () => `key-number-${++n}`;
}

describe('IntentKeys', () => {
  it('hands the same key back for the same intent until it settles', () => {
    const keys = new IntentKeys(counter());
    const first = keys.keyFor('fish:a');
    expect(keys.keyFor('fish:a')).toBe(first);
    expect(keys.keyFor('fish:b')).not.toBe(first);
    keys.settle('fish:a');
    expect(keys.keyFor('fish:a')).not.toBe(first);
  });

  it('lets an abandoned intent go after the window, so the same intent later is a new purchase', () => {
    let at = 0;
    const keys = new IntentKeys(counter(), () => at, 1000);
    const first = keys.keyFor('fish:a');
    at = 999;
    expect(keys.keyFor('fish:a')).toBe(first);
    at = 1000;
    expect(keys.keyFor('fish:a')).not.toBe(first);
  });

  it('forgets everything on clear', () => {
    const keys = new IntentKeys(counter());
    const first = keys.keyFor('x');
    keys.clear();
    expect(keys.keyFor('x')).not.toBe(first);
  });

  it('makes keys the server accepts, all different', () => {
    const made = new Set(Array.from({ length: 50 }, newIdempotencyKey));
    expect(made.size).toBe(50);
    for (const key of made) expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
  });
});

describe('outcomeUnknown', () => {
  it('keeps the key when the request may have been processed', () => {
    expect(outcomeUnknown(apiError(0, 'network'))).toBe(true);
    expect(outcomeUnknown(apiError(0, 'timeout'))).toBe(true);
    expect(outcomeUnknown(apiError(502, 'internal'))).toBe(true);
    expect(outcomeUnknown(apiError(429, 'rate_limited'))).toBe(true);
    expect(outcomeUnknown(apiError(200, 'unexpected_response'))).toBe(true);
  });

  it('lets the key go when the server refused for a reason', () => {
    expect(outcomeUnknown(apiError(402, 'insufficient_pearls'))).toBe(false);
    expect(outcomeUnknown(apiError(409, 'conflict'))).toBe(false);
    expect(outcomeUnknown(apiError(400, 'validation_failed'))).toBe(false);
    expect(outcomeUnknown(new Error('bug'))).toBe(false);
  });
});
