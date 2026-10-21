import { describe, expect, it, vi } from 'vitest';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { CurrentField } from '../scene/current';

vi.mock('@aquarium/sim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aquarium/sim')>()),
  waveMakerForTier: () => ({
    direction: [1, 0] as const,
    speedMps: 0,
    mode: 'steady' as const,
    periodS: 10,
  }),
}));

describe('pumpFieldFor with a tier that has no flow', () => {
  it('is no pump rather than a field FlowField would reject', async () => {
    const { pumpFieldFor } = await import('./pumpField');
    const field = pumpFieldFor(1, TANK_DIMENSIONS.standard);
    expect(field).toBeNull();
    expect(() => new CurrentField().setWaveMaker(field, 0)).not.toThrow();
  });
});
