import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { pearlText } from '../sync/economy';
import {
  UNCONFIRMED_NOTICE,
  awaitCredit,
  canSubscribe,
  euros,
  goToCheckout,
  loadPayments,
  parsePending,
  paymentErrorText,
  paymentNotice,
  WAITING_NOTICE,
  paymentReturn,
  withoutPaymentReturn,
  type PaymentReturn,
  type PaymentsView,
  type PendingCheckout,
} from '../sync/payments';
import type { TankSession } from '../sync/session';
import { useApi } from './context';
import { Link } from './screens';
import { PEARL_PACKS_ID } from './spend';

const PENDING_KEY = 'aquarium.payment-pending';

function readPending(): PendingCheckout | null {
  try {
    return parsePending(sessionStorage.getItem(PENDING_KEY));
  } catch {
    return null;
  }
}

function writePending(pending: PendingCheckout | null): void {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Private mode: the return screen then cannot tell what was bought and stays neutral.
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
  const notice = useSyncExternalStore(paymentNotice.subscribe, paymentNotice.get);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState(false);
  const [waiver, setWaiver] = useState(false);

  const load = useCallback(async () => {
    try {
      return { phase: 'done', view: await loadPayments(api) } as const;
    } catch (error) {
      return { phase: 'failed', message: paymentErrorText(error) } as const;
    }
  }, [api]);

  const live = useRef<((next: Loaded) => void) | null>(null);
  useEffect(() => {
    live.current = setLoaded;
    return () => {
      live.current = null;
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      const first = await load();
      if (abort.signal.aborted) return;
      setLoaded(first);
      if (!returned || paymentReturn(window.location.search) === null) return;
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
        paymentNotice.set('Checkout was cancelled. Nothing was charged.');
        return;
      }
      if (!pending || (pending.kind === 'pack' && pending.balance === null)) {
        paymentNotice.set(UNCONFIRMED_NOTICE);
        return;
      }
      paymentNotice.set(WAITING_NOTICE);
      const subscription = pending.kind === 'subscription';
      const read = async (): Promise<number | null> => {
        try {
          if (subscription) {
            const next = await load();
            if (next.phase === 'done' && next.view.kind === 'ready') {
              live.current?.(next);
              return canSubscribe(next.view.state.subscription) ? 0 : 1;
            }
            return null;
          }
          await session.refreshWallet({ afterWrite: true });
          return session.getState().balance;
        } catch {
          return null;
        }
      };
      const credited = await awaitCredit({
        read,
        before: pending.kind === 'pack' ? pending.balance : 0,
        signal: new AbortController().signal,
      });
      paymentNotice.set(
        credited
          ? subscription
            ? 'You are now an Aquarist Club member. Your daily Pearls start today.'
            : 'Your Pearls have arrived.'
          : 'The payment has not been confirmed yet. Your Pearls arrive as soon as it is, usually within a minute.',
      );
    })();
    return () => abort.abort();
  }, [load, returned, session]);

  useEffect(
    () => () => {
      if (paymentNotice.get() !== WAITING_NOTICE) paymentNotice.set(null);
    },
    [],
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

  const heading = (
    <h3 id={`${id}-h`} tabIndex={-1}>
      Pearl packs and Aquarist Club
    </h3>
  );

  if (loaded.phase === 'loading') {
    return (
      <section id={PEARL_PACKS_ID} aria-labelledby={`${id}-h`} className="block" aria-busy="true">
        {heading}
        <p className="hint">Loading prices.</p>
      </section>
    );
  }

  const status = <div role="status">{notice && <p className="hint">{notice}</p>}</div>;

  if (loaded.phase === 'failed') {
    return (
      <section id={PEARL_PACKS_ID} aria-labelledby={`${id}-h`} className="block">
        {heading}
        {status}
        <p className="hint">Prices could not be loaded. {loaded.message}</p>
      </section>
    );
  }

  if (loaded.view.kind === 'off') {
    return (
      <section id={PEARL_PACKS_ID} aria-labelledby={`${id}-h`} className="block">
        {heading}
        {status}
        <p className="hint">Purchases are not available yet. Everything else works as usual.</p>
      </section>
    );
  }

  const { state, packs, offer } = loaded.view;
  const subscription = state.subscription;
  const consentReady = state.adultConfirmed && delivery && waiver;

  const buyPack = async (packId: string) => {
    if (!delivery || !waiver) return;
    await attempt(async () => {
      writePending({ kind: 'pack', balance });
      try {
        goToCheckout(
          await api.checkoutPack(packId, { immediateDelivery: delivery, withdrawalWaiver: waiver }),
        );
      } catch (error) {
        writePending(null);
        throw error;
      }
    });
  };

  const subscribe = async () => {
    if (!delivery || !waiver) return;
    await attempt(async () => {
      writePending({ kind: 'subscription' });
      try {
        goToCheckout(
          await api.checkoutSubscription({
            immediateDelivery: delivery,
            withdrawalWaiver: waiver,
          }),
        );
      } catch (error) {
        writePending(null);
        throw error;
      }
    });
  };

  return (
    <section id={PEARL_PACKS_ID} aria-labelledby={`${id}-h`} className="block">
      {heading}
      {status}
      <p className="hint">
        Pearls are bought with real money through Stripe. You are sent to Stripe to pay, and the
        Pearls arrive once the payment is confirmed. Basic care stays free.
      </p>
      {!state.adultConfirmed && (
        <p className="hint">
          An adult has to confirm purchases once in the <Link to="/settings">account settings</Link>{' '}
          before you can buy.
        </p>
      )}
      <label className="row">
        <input
          type="checkbox"
          checked={delivery}
          disabled={busy}
          onChange={(e) => setDelivery(e.target.checked)}
        />
        <span>I want my Pearls delivered right away.</span>
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={waiver}
          disabled={busy}
          onChange={(e) => setWaiver(e.target.checked)}
        />
        <span>I understand that this ends my 14-day right of withdrawal for what I buy.</span>
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
        time in one step from the account settings.
      </p>
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
      </div>
      {!canSubscribe(subscription) && (
        <p className="hint">
          Your membership and its cancel button are in the{' '}
          <Link to="/settings">account settings</Link>.
        </p>
      )}
    </section>
  );
}
