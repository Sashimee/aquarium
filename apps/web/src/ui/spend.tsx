import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BUNDLED_ECONOMY } from '../sync/bundledEconomy';
import {
  packText,
  pearlText,
  shortfallSentence,
  spendQuestion,
  type Shortfall,
} from '../sync/economy';
import type { TankSession } from '../sync/session';
import { affordNow, runSpend } from '../sync/spending';

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
  const confirmRef = useRef<HTMLButtonElement>(null);

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
          {packText(short.offer.pack)} would leave you {pearlText(short.offer.leftover)}. Pearl
          packs are not on sale yet, so nothing can be bought here today. Nothing is charged until
          you choose to buy, and playing earns Pearls too.
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
