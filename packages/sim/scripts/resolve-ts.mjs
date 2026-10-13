// @aquarium/shared imports siblings as './x.js' for tsc, but ships only .ts sources, which
// Node's type stripping cannot find on its own.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
