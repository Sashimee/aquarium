import type { CheckoutResponse, Pack, PacksResponse, PaymentsState } from '@aquarium/shared';
import { ApiRequestError, type ApiClient } from '../ui/api';
import { backoffDelay, realSleep, type Sleep } from './backoff';

export type PaymentsView =
  | { kind: 'off' }
  | {
      kind: 'ready';
      state: PaymentsState;
      packs: readonly Pack[];
      offer: PacksResponse['subscription'];
    };

/** The state route answers even with payments off; the packs route is what answers 503. */
export async function loadPayments(api: ApiClient): Promise<PaymentsView> {
  const state = await api.paymentsState();
  if (state.payments === 'disabled') return { kind: 'off' };
  try {
    const { packs, subscription } = await api.paymentsPacks();
    return { kind: 'ready', state, packs, offer: subscription };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 503) return { kind: 'off' };
    throw error;
  }
}

export type PaymentReturn = 'success' | 'cancelled';

export function paymentReturn(search: string): PaymentReturn | null {
  const value = new URLSearchParams(search).get('payment');
  return value === 'success' || value === 'cancelled' ? value : null;
}

export function withoutPaymentReturn(path: string): string {
  const url = new URL(path, 'https://placeholder.invalid');
  url.searchParams.delete('payment');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function euros(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

export function dateText(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

const LIVE = ['active', 'past_due', 'unpaid', 'trialing'];

export function subscriptionSummary(
  subscription: PaymentsState['subscription'],
  nowMs: number,
): string | null {
  if (!subscription) return null;
  const until = subscription.paidUntil ? dateText(subscription.paidUntil) : null;
  switch (subscription.status) {
    case 'active':
    case 'trialing':
      if (subscription.cancelAtPeriodEnd) {
        return until
          ? `Your Aquarist Club membership is cancelled and runs until ${until}. No further payment is taken.`
          : 'Your Aquarist Club membership is cancelled. No further payment is taken.';
      }
      return until
        ? `You are an Aquarist Club member. Paid until ${until}, then it renews.`
        : 'You are an Aquarist Club member.';
    case 'past_due':
    case 'unpaid':
      return 'The last Aquarist Club payment did not go through. Fix the payment method with Stripe, or cancel below.';
    case 'canceled':
      return subscription.paidUntil && Date.parse(subscription.paidUntil) > nowMs
        ? `Your Aquarist Club membership has ended. It was paid until ${until}.`
        : 'Your Aquarist Club membership has ended.';
    case 'paused':
      return 'Your Aquarist Club membership is paused.';
    default:
      return null;
  }
}

export function canCancel(subscription: PaymentsState['subscription']): boolean {
  return (
    subscription !== null && !subscription.cancelAtPeriodEnd && LIVE.includes(subscription.status)
  );
}

export function canSubscribe(subscription: PaymentsState['subscription']): boolean {
  return subscription === null || !LIVE.includes(subscription.status);
}

export function paymentErrorText(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Something went wrong. Nothing was charged.';
  if (error.status === 503) return 'Purchases are not available yet.';
  if (error.status === 409) return error.message;
  switch (error.code) {
    case 'adult_confirmation_required':
      return 'An adult has to confirm purchases first. Tick the box above.';
    case 'email_not_verified':
      return 'Verify your email address before buying Pearls.';
    case 'rate_limited':
      return error.retryAfterSeconds
        ? `Too many attempts. Try again in ${error.retryAfterSeconds} s.`
        : 'Too many attempts. Try again in a little while.';
    case 'network':
    case 'timeout':
      return 'Could not reach the server. Nothing was charged; try again.';
    default:
      return error.message;
  }
}

export const WALLET_POLL_ATTEMPTS = 8;

/**
 * The webhook credits the wallet, not the browser returning from Checkout, so the balance is read
 * until it rises. Bounded: after the last attempt the caller says it may take a little longer.
 */
export async function awaitCredit(options: {
  read(): Promise<number | null>;
  before: number | null;
  signal: AbortSignal;
  sleep?: Sleep;
  attempts?: number;
}): Promise<boolean> {
  const sleep = options.sleep ?? realSleep;
  const attempts = options.attempts ?? WALLET_POLL_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal.aborted) return false;
    const balance = await options.read();
    if (balance !== null && (options.before === null || balance > options.before)) return true;
    if (attempt + 1 < attempts) {
      try {
        await sleep(backoffDelay(attempt, { baseMs: 1_000, maxMs: 15_000 }), options.signal);
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function goToCheckout(response: CheckoutResponse): void {
  window.location.assign(response.url);
}
