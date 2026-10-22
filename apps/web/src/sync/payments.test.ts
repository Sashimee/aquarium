import type { PaymentsState } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient } from '../ui/api';
import {
  awaitCredit,
  canCancel,
  canSubscribe,
  loadPayments,
  paymentErrorText,
  paymentReturn,
  subscriptionSummary,
  withoutPaymentReturn,
} from './payments';

const enabled: PaymentsState = { payments: 'enabled', adultConfirmed: true, subscription: null };
const offer = { id: 'club', priceCents: 499, interval: 'month', pearlsPerDay: 20 } as const;
const packs = [{ id: 'pearls-550', priceCents: 499, pearls: 550, webAvailable: true }];
const unavailable = () => new ApiRequestError(503, 'payments_disabled', 'off');

describe('loadPayments', () => {
  it('lists the packs and offer the server sends', async () => {
    const api = {
      paymentsState: vi.fn().mockResolvedValue(enabled),
      paymentsPacks: vi.fn().mockResolvedValue({ packs, subscription: offer }),
    } as unknown as ApiClient;
    expect(await loadPayments(api)).toEqual({ kind: 'ready', state: enabled, packs, offer });
  });

  it('is off, without asking for packs, when the state says disabled', async () => {
    const paymentsPacks = vi.fn();
    const api = {
      paymentsState: vi.fn().mockResolvedValue({ ...enabled, payments: 'disabled' }),
      paymentsPacks,
    } as unknown as ApiClient;
    expect(await loadPayments(api)).toEqual({ kind: 'off' });
    expect(paymentsPacks).not.toHaveBeenCalled();
  });

  it('is off when the packs route answers 503', async () => {
    const api = {
      paymentsState: vi.fn().mockResolvedValue(enabled),
      paymentsPacks: vi.fn().mockRejectedValue(unavailable()),
    } as unknown as ApiClient;
    expect(await loadPayments(api)).toEqual({ kind: 'off' });
  });

  it('rethrows other failures', async () => {
    const api = {
      paymentsState: vi.fn().mockResolvedValue(enabled),
      paymentsPacks: vi.fn().mockRejectedValue(new ApiRequestError(500, 'internal', 'boom')),
    } as unknown as ApiClient;
    await expect(loadPayments(api)).rejects.toThrow('boom');
  });
});

describe('the return from Checkout', () => {
  it('reads only the two known values', () => {
    expect(paymentReturn('?payment=success')).toBe('success');
    expect(paymentReturn('?payment=cancelled')).toBe('cancelled');
    expect(paymentReturn('?payment=<script>')).toBeNull();
    expect(paymentReturn('')).toBeNull();
  });

  it('removes the parameter and keeps the rest', () => {
    expect(withoutPaymentReturn('/?payment=success&tank=a#x')).toBe('/?tank=a#x');
    expect(withoutPaymentReturn('/?payment=cancelled')).toBe('/');
  });
});

describe('subscription state', () => {
  const sub = (over: Partial<NonNullable<PaymentsState['subscription']>>) => ({
    status: 'active' as const,
    paidUntil: '2026-11-20T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    ...over,
  });
  const now = Date.parse('2026-10-23T00:00:00Z');

  it('shows the paid-until date of a running membership and allows cancel', () => {
    expect(subscriptionSummary(sub({}), now)).toContain('20 November 2026');
    expect(canCancel(sub({}))).toBe(true);
    expect(canSubscribe(sub({}))).toBe(false);
  });

  it('shows a cancelled membership as running to the end, with no second cancel', () => {
    const cancelled = sub({ cancelAtPeriodEnd: true });
    expect(subscriptionSummary(cancelled, now)).toContain('cancelled and runs until 20 November');
    expect(canCancel(cancelled)).toBe(false);
  });

  it('offers a new subscription once it has ended', () => {
    const ended = sub({ status: 'canceled', paidUntil: '2026-09-01T00:00:00.000Z' });
    expect(subscriptionSummary(ended, now)).toBe('Your Aquarist Club membership has ended.');
    expect(canSubscribe(ended)).toBe(true);
    expect(canCancel(ended)).toBe(false);
    expect(canSubscribe(null)).toBe(true);
  });

  it('warns about a failed payment and still allows cancel', () => {
    expect(subscriptionSummary(sub({ status: 'past_due' }), now)).toContain('did not go through');
    expect(canCancel(sub({ status: 'past_due' }))).toBe(true);
  });
});

describe('paymentErrorText', () => {
  it('maps the documented failures to plain sentences', () => {
    expect(paymentErrorText(unavailable())).toBe('Purchases are not available yet.');
    expect(
      paymentErrorText(new ApiRequestError(409, 'conflict', 'You have no active subscription.')),
    ).toBe('You have no active subscription.');
    expect(
      paymentErrorText(new ApiRequestError(403, 'adult_confirmation_required', 'x')),
    ).toContain('adult');
    expect(paymentErrorText(new ApiRequestError(429, 'rate_limited', 'x', {}, 12))).toContain(
      '12 s',
    );
    expect(paymentErrorText(new ApiRequestError(0, 'network', 'x'))).toContain(
      'Nothing was charged',
    );
    expect(paymentErrorText(new Error('x'))).toContain('Nothing was charged');
  });
});

describe('awaitCredit', () => {
  const signal = new AbortController().signal;

  it('stops as soon as the balance rises', async () => {
    const reads = [100, 100, 650];
    const sleep = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn(async () => reads.shift() ?? 650);
    expect(await awaitCredit({ read, before: 100, signal, sleep })).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded number of attempts with growing waits', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue(100);
    expect(await awaitCredit({ read, before: 100, signal, sleep, attempts: 4 })).toBe(false);
    expect(read).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    const waits = sleep.mock.calls.map((c) => c[0] as number);
    expect(waits[2]).toBeGreaterThan(waits[0] as number);
  });

  it('stops when aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const read = vi.fn();
    expect(await awaitCredit({ read, before: 1, signal: abort.signal })).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
