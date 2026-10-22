import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PaymentsState } from '@aquarium/shared';
import { pearlText } from '../sync/economy';
import {
  awaitCredit,
  canCancel,
  canSubscribe,
  euros,
  goToCheckout,
  loadPayments,
  paymentErrorText,
  paymentReturn,
  subscriptionSummary,
  withoutPaymentReturn,
  type PaymentReturn,
  type PaymentsView,
} from '../sync/payments';
import type { TankSession } from '../sync/session';
import { useApi } from './context';

const PENDING_KEY = 'aquarium.payment-pending';

type Pending = { kind: 'pack'; balance: number | null } | { kind: 'subscription' };

function readPending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

function writePending(pending: Pending | null): void {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Private mode: the return screen then reads the balance once without a baseline.
  }
}

interface Props {
  session: TankSession;
  balance: number | null;
}

type Loaded =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'done'; view: PaymentsView };

export function PaymentsShop({ session, balance }: Props) {
  const api = useApi();
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const [returned] = useState<PaymentReturn | null>(() => paymentReturn(window.location.search));
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);

  const load = useCallback(async () => {
    try {
      return { phase: 'done', view: await loadPayments(api) } as const;
    } catch (error) {
      return { phase: 'failed', message: paymentErrorText(error) } as const;
    }
  }, [api]);

  const settled = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      const first = await load();
      if (abort.signal.aborted) return;
      setLoaded(first);
      if (!returned || settled.current) return;
      settled.current = true;
      window.history.replaceState(
        window.history.state,
        '',
        withoutPaymentReturn(
          window.location.pathname + window.location.search + window.location.hash,
        ),
      );
      const pending = readPending();
      writePending(null);
      if (returned === 'cancelled') {
        setNotice('Checkout was cancelled. Nothing was charged.');
        return;
      }
      setNotice('Thank you. Waiting for the payment to be confirmed.');
      const subscription = pending?.kind === 'subscription';
      const read = async (): Promise<number | null> => {
        if (subscription) {
          const next = await load();
          if (next.phase === 'done' && next.view.kind === 'ready') {
            setLoaded(next);
            return canSubscribe(next.view.state.subscription) ? 0 : 1;
          }
          return null;
        }
        await session.refreshWallet({ afterWrite: true });
        return session.getState().balance;
      };
      const credited = await awaitCredit({
        read,
        before: subscription ? 0 : (pending?.balance ?? null),
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setNotice(
        credited
          ? subscription
            ? 'You are now an Aquarist Club member. Your daily Pearls start today.'
            : 'Your Pearls have arrived.'
          : 'The payment has not been confirmed yet. Your Pearls arrive as soon as it is, usually within a minute.',
      );
    })();
    return () => abort.abort();
  }, [load, returned, session]);

  const apply = (state: PaymentsState) =>
    setLoaded((prev) =>
      prev.phase === 'done' && prev.view.kind === 'ready'
        ? { phase: 'done', view: { ...prev.view, state } }
        : prev,
    );

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(paymentErrorText(error));
      const next = await load();
      if (next.phase === 'done') setLoaded(next);
    } finally {
      setBusy(false);
    }
  };

  const heading = <h3 id={`${id}-h`}>Pearl packs and Aquarist Club</h3>;

  if (loaded.phase === 'loading') {
    return (
      <section aria-labelledby={`${id}-h`} className="block" aria-busy="true">
        {heading}
        <p className="hint">Loading prices.</p>
      </section>
    );
  }

  const status = <div role="status">{notice && <p className="hint">{notice}</p>}</div>;

  if (loaded.phase === 'failed') {
    return (
      <section aria-labelledby={`${id}-h`} className="block">
        {heading}
        {status}
        <p className="hint">Prices could not be loaded. {loaded.message}</p>
      </section>
    );
  }

  if (loaded.view.kind === 'off') {
    return (
      <section aria-labelledby={`${id}-h`} className="block">
        {heading}
        {status}
        <p className="hint">Purchases are not available yet. Everything else works as usual.</p>
      </section>
    );
  }

  const { state, packs, offer } = loaded.view;
  const subscription = state.subscription;
  const summary = subscriptionSummary(subscription, Date.now());
  const consentReady = state.adultConfirmed && consent;

  const buyPack = (packId: string) =>
    attempt(async () => {
      writePending({ kind: 'pack', balance });
      try {
        goToCheckout(
          await api.checkoutPack(packId, { immediateDelivery: true, withdrawalWaiver: true }),
        );
      } catch (error) {
        writePending(null);
        throw error;
      }
    });

  const subscribe = () =>
    attempt(async () => {
      writePending({ kind: 'subscription' });
      try {
        goToCheckout(
          await api.checkoutSubscription({ immediateDelivery: true, withdrawalWaiver: true }),
        );
      } catch (error) {
        writePending(null);
        throw error;
      }
    });

  const cancel = () =>
    attempt(async () => {
      apply(await api.cancelSubscription());
      setNotice('Your membership is cancelled. It keeps working until the end of the paid period.');
    });

  return (
    <section aria-labelledby={`${id}-h`} className="block">
      {heading}
      {status}
      <p className="hint">
        Pearls are bought with real money through Stripe. You are sent to Stripe to pay, and the
        Pearls arrive once the payment is confirmed. Basic care stays free.
      </p>
      <label className="row">
        <input
          type="checkbox"
          checked={state.adultConfirmed}
          disabled={busy}
          onChange={(e) =>
            void attempt(async () => apply(await api.setAdultConfirmation(e.target.checked)))
          }
        />
        <span>I am an adult and I confirm purchases on this account.</span>
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span>
          Deliver my Pearls now. I understand that this ends my 14-day right of withdrawal for what
          I buy.
        </span>
      </label>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      <ul className="shop" aria-label="Pearl packs">
        {packs.map((pack) => (
          <li key={pack.id}>
            <div>
              <strong>{pearlText(pack.pearls)}</strong>{' '}
              <span className="price">{euros(pack.priceCents)}</span>
            </div>
            <button
              type="button"
              disabled={busy || !consentReady}
              aria-label={`Buy ${pearlText(pack.pearls)} for ${euros(pack.priceCents)}`}
              onClick={() => void buyPack(pack.id)}
            >
              Buy
            </button>
          </li>
        ))}
      </ul>
      <h4>Aquarist Club</h4>
      <p className="hint">
        {pearlText(offer.pearlsPerDay)} every day for {euros(offer.priceCents)} a month. Cancel any
        time in one step.
      </p>
      {summary && <p className="hint">{summary}</p>}
      <div className="row">
        {canSubscribe(subscription) && (
          <button
            type="button"
            disabled={busy || !consentReady}
            aria-label={`Join the Aquarist Club for ${euros(offer.priceCents)} a month`}
            onClick={() => void subscribe()}
          >
            Join
          </button>
        )}
        {canCancel(subscription) && (
          <button type="button" disabled={busy} onClick={() => void cancel()}>
            Cancel membership
          </button>
        )}
      </div>
    </section>
  );
}
