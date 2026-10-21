import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient } from '../ui/api';
import { apiError, FISH_1, fishFixture, recordBus, speciesFixture, tankFixture } from './fixtures';
import { TankSession } from './session';

function setup() {
  const sick = fishFixture(FISH_1, {
    disease: {
      kind: 'ich',
      since: '2026-02-01T00:00:00.000Z',
      severity: 0.4,
      treatedUntil: null,
    },
  });
  const api = {
    species: vi.fn().mockResolvedValue([speciesFixture()]),
    tanks: vi.fn().mockResolvedValue([tankFixture({ fish: [sick] })]),
    wallet: vi.fn().mockResolvedValue({ balance: 500, owned: [] }),
    treat: vi.fn(),
  };
  const session = new TankSession({
    api: api as unknown as ApiClient,
    interaction: recordBus().bus,
    sleep: async () => undefined,
    layoutDebounceMs: 700,
    now: () => Date.parse('2026-02-01T12:00:00.000Z'),
  });
  return { api, session };
}

describe('a refused dose', () => {
  it('is reported once, by the outcome, not also as a session error', async () => {
    const { api, session } = setup();
    await session.setUser({ emailVerified: true });
    const water = 'Change the water until only a trace is left, then switch.';
    api.treat.mockRejectedValue(new ApiRequestError(409, 'conflict', water));
    const outcome = await session.treat('ich', 'standard');
    expect(outcome.refusal).toBe(water);
    expect(session.getState().error).toBeNull();
  });

  it('still reports other failures as a session error', async () => {
    const { api, session } = setup();
    await session.setUser({ emailVerified: true });
    api.treat.mockRejectedValue(apiError(500, 'unexpected_response'));
    const outcome = await session.treat('ich', 'standard');
    expect(outcome.refusal).toBeNull();
    expect(session.getState().error).not.toBeNull();
  });
});
