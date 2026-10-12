import { describe, expect, it } from 'vitest';
import { benchmarkConfig } from './fixtures.ts';
import { World } from './world.ts';

describe('step budget', () => {
  it('steps 60 fish well inside the 2 ms desktop budget', () => {
    const w = new World(benchmarkConfig(1));
    expect(w.count).toBe(60);
    for (let t = 0; t < 300; t++) w.step();
    const steps = 1500;
    const start = performance.now();
    for (let t = 0; t < steps; t++) w.step();
    expect((performance.now() - start) / steps).toBeLessThan(2);
  });
});
