import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_ECONOMY } from './bundledEconomy';
import { affordNow, runSpend, type WalletSource } from './spending';

const economy = BUNDLED_ECONOMY;

function wallet(balance: number | null, fresh: number | null = balance) {
  const state = { balance, pearlsRefused: false };
  const source: WalletSource = {
    getState: () => state,
    refreshWallet: vi.fn(async () => {
      state.balance = fresh;
    }),
    clearMessages: vi.fn(),
  };
  return { state, source };
}

describe('affordNow', () => {
  it('lets an affordable purchase through without asking the server', async () => {
    const { source } = wallet(500);
    expect(await affordNow(source, 150, economy)).toEqual({ kind: 'ok' });
    expect(source.refreshWallet).not.toHaveBeenCalled();
  });

  it('re-reads the wallet before saying no, so Pearls earned in the meantime count', async () => {
    const { source } = wallet(30, 180);
    expect(await affordNow(source, 150, economy)).toEqual({ kind: 'ok' });
    expect(source.refreshWallet).toHaveBeenCalledOnce();
  });

  it('reports the shortfall from the fresh balance when it is still too low', async () => {
    const { source } = wallet(30, 40);
    const verdict = await affordNow(source, 150, economy);
    expect(verdict).toMatchObject({ kind: 'short', balance: 40, shortfall: 110 });
  });

  it('lets a purchase through while the balance is unknown', async () => {
    const { source } = wallet(null);
    expect(await affordNow(source, 800, economy)).toEqual({ kind: 'ok' });
  });
});

describe('runSpend', () => {
  it('returns nothing when the purchase worked', async () => {
    const { source } = wallet(500);
    expect(await runSpend(source, { price: 150, go: async () => true }, economy)).toBeNull();
  });

  it('starts the shortfall flow when the server refused for too few Pearls', async () => {
    const { source, state } = wallet(500);
    const go = async () => {
      state.balance = 100;
      state.pearlsRefused = true;
      return false;
    };
    const verdict = await runSpend(source, { price: 150, go }, economy);
    expect(verdict).toMatchObject({ kind: 'short', balance: 100, shortfall: 50 });
    expect(source.clearMessages).toHaveBeenCalledOnce();
  });

  it('leaves other failures to the error message the session already shows', async () => {
    const { source } = wallet(500);
    expect(await runSpend(source, { price: 150, go: async () => false }, economy)).toBeNull();
    expect(source.clearMessages).not.toHaveBeenCalled();
  });
});
