import { describe, expect, it } from 'vitest';
import {
  adultConfirmationRequestSchema,
  checkoutResponseSchema,
  errorCodeSchema,
  healthResponseSchema,
  packCheckoutRequestSchema,
  packsResponseSchema,
  paymentsStateSchema,
  subscriptionCheckoutRequestSchema,
} from './index.js';

const consent = { immediateDelivery: true, withdrawalWaiver: true };

describe('checkout requests', () => {
  it('needs both consents set to true', () => {
    expect(packCheckoutRequestSchema.safeParse({ packId: 'pearls-550', consent }).success).toBe(
      true,
    );
    for (const missing of ['immediateDelivery', 'withdrawalWaiver']) {
      const partial = { ...consent, [missing]: false };
      expect(
        packCheckoutRequestSchema.safeParse({ packId: 'pearls-550', consent: partial }).success,
      ).toBe(false);
      expect(subscriptionCheckoutRequestSchema.safeParse({ consent: partial }).success).toBe(false);
    }
  });

  it('never accepts an amount from the client', () => {
    expect(
      packCheckoutRequestSchema.safeParse({ packId: 'pearls-550', consent, priceCents: 1 }).success,
    ).toBe(false);
  });
});

describe('checkout bounds', () => {
  it('caps the pack id length', () => {
    expect(packCheckoutRequestSchema.safeParse({ packId: 'a'.repeat(65), consent }).success).toBe(
      false,
    );
  });

  it('only sends the browser to https', () => {
    expect(
      checkoutResponseSchema.safeParse({ url: 'https://checkout.stripe.com/c/pay' }).success,
    ).toBe(true);
    for (const url of ['javascript:alert(1)', 'http://checkout.stripe.com/c', 'data:text/html,x']) {
      expect(checkoutResponseSchema.safeParse({ url }).success, url).toBe(false);
    }
  });
});

describe('payments state', () => {
  it('reports disabled payments without a subscription', () => {
    expect(
      paymentsStateSchema.parse({
        payments: 'disabled',
        adultConfirmed: false,
        subscription: null,
      }),
    ).toEqual({ payments: 'disabled', adultConfirmed: false, subscription: null });
  });

  it('carries the subscription period', () => {
    const parsed = paymentsStateSchema.parse({
      payments: 'enabled',
      adultConfirmed: true,
      subscription: {
        status: 'active',
        paidUntil: '2026-11-22T00:00:00.000Z',
        cancelAtPeriodEnd: false,
      },
    });
    expect(parsed.subscription?.status).toBe('active');
  });
});

describe('health', () => {
  it('always states whether payments are on', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok' }).success).toBe(false);
    expect(healthResponseSchema.safeParse({ status: 'ok', payments: 'disabled' }).success).toBe(
      true,
    );
  });
});

it('has error codes for a disabled shop and a missing adult confirmation', () => {
  expect(errorCodeSchema.options).toContain('payments_disabled');
  expect(errorCodeSchema.options).toContain('adult_confirmation_required');
});

it('parses the pack list and the adult confirmation body', () => {
  expect(
    packsResponseSchema.parse({
      packs: [{ id: 'pearls-550', priceCents: 499, pearls: 550, webAvailable: true }],
      subscription: { id: 'aquarist-club', priceCents: 499, interval: 'month', pearlsPerDay: 20 },
    }).packs,
  ).toHaveLength(1);
  expect(adultConfirmationRequestSchema.parse({ confirmed: true })).toEqual({ confirmed: true });
});
