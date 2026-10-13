import { describe, expect, it } from 'vitest';
import { scaleCaudal, type FinResult } from './fins.ts';
import { FIN_IDS } from './index-schema.ts';

describe('scaleCaudal', () => {
  const positions = Float32Array.from([0, 1, 0.05, 0, 1, 0.5, 0, 3, -1, 0.2, 2, 1.5]);
  const fins: FinResult = {
    mask: new Float32Array(4),
    id: Float32Array.from([0, 0, FIN_IDS.caudal, FIN_IDS.dorsal]),
    zSnout: 2,
    zPeduncle: 0,
    zTail: -1,
  };

  it('scales only caudal vertices, about the peduncle centre', () => {
    scaleCaudal(positions, fins, 0.5);
    expect([...positions.slice(6, 9)]).toEqual([0, 2, -0.5]);
    expect(positions[2]).toBeCloseTo(0.05);
    expect(positions[5]).toBeCloseTo(0.5);
    expect(positions[9]).toBeCloseTo(0.2);
    expect(positions[11]).toBeCloseTo(1.5);
  });
});
