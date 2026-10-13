import { describe, expect, it } from 'vitest';
import { benchmarkConfig, FoodRain, REEF_TANK } from './fixtures.ts';
import { World } from './world.ts';

describe('step budget', () => {
  it('steps 60 fish well inside the 2 ms desktop budget', () => {
    const w = new World(benchmarkConfig(1));
    expect(w.count).toBe(60);
    for (let t = 0; t < 300; t++) w.step();
    const steps = 1500;
    const start = performance.now();
    for (let t = 0; t < steps; t++) w.step();
    const mean = (performance.now() - start) / steps;
    expect(mean).toBeLessThan(2);
    // A 4x CPU throttle scales script time about linearly; its budget is 4 ms.
    expect(4 * mean).toBeLessThan(4);
  });

  it('stays inside the budget with a few hundred food particles in the water', () => {
    const w = new World(benchmarkConfig(2));
    const rain = new FoodRain(REEF_TANK);
    const steps = 900;
    let elapsed = 0;
    let particles = 0;
    const timed = {
      substrateSdf: w.substrateSdf,
      setFood(buffer: Float32Array): void {
        const t0 = performance.now();
        w.setFood(buffer);
        elapsed += performance.now() - t0;
        particles += buffer.length / 5;
      },
    };
    for (let t = 0; t < steps; t++) {
      if (rain.count < 250) {
        rain.sprinkle('flakes', 240, 0.4 * Math.sin(t), 0.1 * Math.cos(t), 0.5, 3);
        rain.sprinkle('pellets', 60, -0.3, 0, 0.3);
      }
      rain.feed(timed);
      const t0 = performance.now();
      w.step();
      elapsed += performance.now() - t0;
      rain.eat(w.takeAteEvents());
    }
    expect(particles / steps).toBeGreaterThan(200);
    expect(rain.eaten).toBeGreaterThan(0);
    const mean = elapsed / steps;
    expect(mean).toBeLessThan(2);
    expect(4 * mean).toBeLessThan(4);
  });
});
