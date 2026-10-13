import { describe, expect, it } from 'vitest';
import { cellEdge, focusAt, layeredAt, netAt, PATTERN_GAIN } from './causticPattern';

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
}

function meanAndSpread(values: number[]): { mean: number; cv: number } {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, cv: Math.sqrt(variance) / mean };
}

describe('caustic pattern', () => {
  it('only redistributes light: its mean times the gain is one', () => {
    const rnd = random(7);
    let sum = 0;
    const n = 60_000;
    for (let k = 0; k < n; k++) {
      const x = rnd() * 300;
      const y = rnd() * 300;
      const t = rnd() * 200;
      sum += layeredAt(x, y, t, focusAt(x, y, t));
    }
    expect((sum / n) * PATTERN_GAIN).toBeCloseTo(1, 1);
  });

  it('varies in contrast across the floor far more than a plain net of the same cells', () => {
    const plainNet = (x: number, y: number): number =>
      Math.max(0, 1 - cellEdge(x, y, 0) / 0.35) ** 4;
    const block = 4;
    const blocks: { contrast: number; focus: number }[] = [];
    const plainContrasts: number[] = [];
    for (let by = 0; by < 24; by++) {
      for (let bx = 0; bx < 24; bx++) {
        const samples: number[] = [];
        const plain: number[] = [];
        let focus = 0;
        for (let j = 0; j < 16; j++) {
          for (let i = 0; i < 16; i++) {
            const x = (bx + i / 16) * block;
            const y = (by + j / 16) * block;
            const f = focusAt(x, y, 0);
            focus += f;
            samples.push(layeredAt(x, y, 0, f));
            plain.push(plainNet(x, y));
          }
        }
        blocks.push({ contrast: meanAndSpread(samples).cv, focus: focus / samples.length });
        plainContrasts.push(meanAndSpread(plain).cv);
      }
    }
    const contrasts = blocks.map((b) => b.contrast);
    expect(meanAndSpread(contrasts).cv).toBeGreaterThan(3 * meanAndSpread(plainContrasts).cv);

    const focused = blocks.filter((b) => b.focus > 0.75).map((b) => b.contrast);
    const defocused = blocks.filter((b) => b.focus < 0.25).map((b) => b.contrast);
    expect(focused.length).toBeGreaterThan(20);
    expect(defocused.length).toBeGreaterThan(20);
    expect(meanAndSpread(focused).mean).toBeGreaterThan(1.5 * meanAndSpread(defocused).mean);
  });

  it('draws filaments of uneven brightness that fade out along their length', () => {
    const rnd = random(11);
    const onFilament: number[] = [];
    while (onFilament.length < 3000) {
      const x = rnd() * 300;
      const y = rnd() * 300;
      if (cellEdge(x, y, 0) < 0.01) onFilament.push(netAt(x, y, 0, 1));
    }
    expect(quantile(onFilament, 0.9)).toBeGreaterThan(4 * quantile(onFilament, 0.1));
    expect(quantile(onFilament, 0.1)).toBeLessThan(0.25);
  });

  it('moves its focus patches slowly: little change in a second, a new layout after a minute', () => {
    const rnd = random(3);
    let soon = 0;
    let later = 0;
    const n = 4000;
    for (let k = 0; k < n; k++) {
      const x = rnd() * 100;
      const y = rnd() * 100;
      const now = focusAt(x, y, 0);
      soon += Math.abs(focusAt(x, y, 0.55) - now);
      later += Math.abs(focusAt(x, y, 33) - now);
    }
    expect(soon / n).toBeLessThan(0.05);
    expect(later / n).toBeGreaterThan(0.2);
  });

  it('wraps seamlessly on the baked tile', () => {
    const period = 10;
    const rnd = random(5);
    for (let k = 0; k < 200; k++) {
      const x = rnd() * period;
      const y = rnd() * period;
      const here = netAt(x, y, 0, focusAt(x, y, 0, period), period);
      const across = netAt(
        x + period,
        y - period,
        0,
        focusAt(x + period, y - period, 0, period),
        period,
      );
      expect(across).toBeCloseTo(here, 6);
    }
  });
});
