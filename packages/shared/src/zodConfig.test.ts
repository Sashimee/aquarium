import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { idSchema } from './index.js';

describe('zod without eval', () => {
  it('runs in jitless mode once the shared package is loaded', () => {
    expect(z.core.globalConfig.jitless).toBe(true);
  });

  it('parses objects without calling Function', () => {
    const schema = z.object({ id: idSchema, n: z.number() });
    const original = globalThis.Function;
    const blocked = vi.fn(() => {
      throw new EvalError('eval is blocked');
    });
    globalThis.Function = blocked as unknown as FunctionConstructor;
    try {
      expect(schema.parse({ id: crypto.randomUUID(), n: 1 }).n).toBe(1);
    } finally {
      globalThis.Function = original;
    }
    expect(blocked).not.toHaveBeenCalled();
  });
});
