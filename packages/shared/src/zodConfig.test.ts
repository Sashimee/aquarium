import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

describe('zod without eval', () => {
  it('builds and parses every shared schema without calling Function', async () => {
    const original = globalThis.Function;
    const blocked = vi.fn(() => {
      throw new EvalError('eval is blocked');
    });
    globalThis.Function = blocked as unknown as FunctionConstructor;
    try {
      // Must be the first load of the shared package in this file: with the zodConfig import
      // misplaced, schemas built at module load probe for eval and call Function.
      const shared = await import('./index.js');
      const schema = z.object({ id: shared.idSchema, n: z.number() });
      expect(schema.parse({ id: crypto.randomUUID(), n: 1 }).n).toBe(1);
      expect(shared.userSchema.safeParse({}).success).toBe(false);
    } finally {
      globalThis.Function = original;
    }
    expect(blocked).not.toHaveBeenCalled();
    expect(z.core.globalConfig.jitless).toBe(true);
  });
});
