import { useEffect, useId, useState } from 'react';
import type { PaymentsState } from '@aquarium/shared';
import { canCancel, paymentErrorText, subscriptionSummary } from '../sync/payments';
import { useApi } from './context';

type Loaded =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'done'; state: PaymentsState };

export function PaymentsSettings() {
  const api = useApi();
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    api.paymentsState().then(
      (state) => {
        if (!abort.signal.aborted) setLoaded({ phase: 'done', state });
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setLoaded({ phase: 'failed', message: paymentErrorText(error) });
      },
    );
    return () => abort.abort();
  }, [api]);

  if (loaded.phase === 'loading') return null;
  const heading = <h2 id={`${id}-h`}>Purchases</h2>;
  if (loaded.phase === 'failed') {
    return (
      <section aria-labelledby={`${id}-h`}>
        {heading}
        <p className="hint">Purchase settings could not be loaded. {loaded.message}</p>
      </section>
    );
  }
  const { state } = loaded;
  if (state.payments === 'disabled') return null;

  const attempt = async (work: () => Promise<PaymentsState>, done?: string) => {
    setBusy(true);
    setProblem(null);
    try {
      setLoaded({ phase: 'done', state: await work() });
      if (done) setNotice(done);
    } catch (error) {
      setProblem(paymentErrorText(error));
      try {
        setLoaded({ phase: 'done', state: await api.paymentsState() });
      } catch {
        // The error above is already on screen; the previous state stays.
      }
    } finally {
      setBusy(false);
    }
  };

  const summary = subscriptionSummary(state.subscription, Date.now());

  return (
    <section aria-labelledby={`${id}-h`}>
      {heading}
      <label className="row">
        <input
          type="checkbox"
          checked={state.adultConfirmed}
          disabled={busy}
          onChange={(e) => void attempt(() => api.setAdultConfirmation(e.target.checked))}
        />
        <span>I am an adult and I confirm purchases on this account.</span>
      </label>
      {summary && <p className="hint">{summary}</p>}
      {canCancel(state.subscription) && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void attempt(
              () => api.cancelSubscription(),
              'Your membership is cancelled. It keeps working until the end of the paid period.',
            )
          }
        >
          Cancel membership
        </button>
      )}
      <p role="status" className="hint">
        {notice}
      </p>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
