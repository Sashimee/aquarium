import type { Economy } from '@aquarium/shared';
import { assessPurchase, type Affordability, type Shortfall } from './economy';

export interface WalletSource {
  getState(): { balance: number | null; pearlsRefused: boolean };
  refreshWallet(): Promise<void>;
  clearMessages(): void;
}

/**
 * The balance on screen can be stale: the server also pays out for care, streaks and achievements.
 * A local shortfall is therefore checked again against a fresh read before the player is told no.
 */
export async function affordNow(
  wallet: WalletSource,
  price: number,
  economy: Economy,
): Promise<Affordability> {
  const local = assessPurchase(wallet.getState().balance, price, economy);
  if (local.kind === 'ok') return local;
  await wallet.refreshWallet();
  return assessPurchase(wallet.getState().balance, price, economy);
}

/**
 * Runs the purchase and returns the shortfall to show when the server refused it for too few
 * Pearls. The server is the final word, so its refusal wins over the client's own check.
 */
export async function runSpend(
  wallet: WalletSource,
  request: { price: number; go(): Promise<boolean> },
  economy: Economy,
): Promise<Shortfall | null> {
  const ok = await request.go();
  if (ok || !wallet.getState().pearlsRefused) return null;
  const verdict = assessPurchase(wallet.getState().balance, request.price, economy);
  if (verdict.kind !== 'short') return null;
  wallet.clearMessages();
  return verdict;
}
