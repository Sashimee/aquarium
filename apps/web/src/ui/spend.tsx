import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { BUNDLED_ECONOMY } from '../sync/bundledEconomy';
import {
  packText,
  pearlText,
  shortfallSentence,
  spendQuestion,
  type Shortfall,
} from '../sync/economy';
import { loadPayments } from '../sync/payments';
import type { TankSession } from '../sync/session';
import { affordNow, runSpend } from '../sync/spending';
import { useOptionalApi } from './context';

export const PEARL_PACKS_ID = 'pearl-packs';

/** Opens the shop when it is not already showing; the Shop panel itself needs nothing. */
export const OpenShopContext = createContext<(() => void) | null>(null);

type Availability = 'unknown' | 'on' | 'off';

const economy = BUNDLED_ECONOMY;

export interface SpendRequest {
  label: string;
  price: number;
  confirm: boolean;
  go(): Promise<boolean>;
}

export interface Spender {
  spend(request: SpendRequest): Promise<void>;
  notice: ReactNode;
}

/**
 * Every Pearl spend goes through here. The balance on screen can be stale, because the server also
 * pays out for care, streaks and achievements, so a local shortfall is checked against a fresh read
 * first, and a refusal from the server is the final word and starts the same shortfall flow.
 */
export function useSpend(session: TankSession, balance: number | null): Spender {
  const [short, setShort] = useState<Shortfall | null>(null);
  const [pending, setPending] = useState<SpendRequest | null>(null);
  const [availability, setAvailability] = useState<Availability>('unknown');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const api = useOptionalApi();
  const openShop = useContext(OpenShopContext);

  const offered = Boolean(short?.offer);
  useEffect(() => {
    if (!offered || !api) return;
    let current = true;
    loadPayments(api).then(
      (view) => current && setAvailability(view.kind === 'off' ? 'off' : 'on'),
      () => current && setAvailability('unknown'),
    );
    return () => {
      current = false;
    };
  }, [offered, api]);

  const showPacks = () => {
    openShop?.();
    window.setTimeout(() => {
      const section = document.getElementById(PEARL_PACKS_ID);
      section?.scrollIntoView?.({ block: 'start' });
      section?.querySelector<HTMLElement>('h3')?.focus();
    }, 0);
  };

  useEffect(() => {
    if (short && balance !== null && balance >= short.price) setShort(null);
  }, [short, balance]);
  useEffect(() => {
    if (pending) confirmRef.current?.focus();
  }, [pending]);

  const run = async (request: SpendRequest) => {
    const refused = await runSpend(session, request, economy);
    if (refused) setShort(refused);
  };

  const spend = async (request: SpendRequest) => {
    setPending(null);
    const verdict = await affordNow(session, request.price, economy);
    if (verdict.kind === 'short') return setShort(verdict);
    setShort(null);
    if (request.confirm && request.price > 0) return setPending(request);
    await run(request);
  };

  const sentence = short
    ? shortfallSentence(short)
    : pending
      ? spendQuestion(pending.label, pending.price, balance)
      : '';

  const notice = (
    <div className="spend">
      <p role="status" className={short ? 'shortfall' : pending ? 'confirm' : 'sr-only'}>
        {sentence}
      </p>
      {short?.offer && (
        <p className="hint">
          {packText(short.offer.pack)} would leave you {pearlText(short.offer.leftover)}.{' '}
          {availability === 'on' && (
            <>
              <a
                href={`#${PEARL_PACKS_ID}`}
                onClick={(e) => {
                  e.preventDefault();
                  showPacks();
                }}
              >
                See the Pearl packs
              </a>{' '}
            </>
          )}
          {availability === 'off' && 'Pearl packs are not available right now. '}
          Nothing is charged until you choose to buy, and playing earns Pearls too.
        </p>
      )}
      {short && (
        <button type="button" onClick={() => setShort(null)}>
          Close this note
        </button>
      )}
      {pending && (
        <div className="row">
          <button
            type="button"
            ref={confirmRef}
            className="primary"
            onClick={() => {
              setPending(null);
              void run(pending);
            }}
          >
            Yes, buy it
          </button>
          <button type="button" onClick={() => setPending(null)}>
            Not now
          </button>
        </div>
      )}
    </div>
  );
  return { spend, notice };
}
