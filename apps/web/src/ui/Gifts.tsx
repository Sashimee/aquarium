import { GIFT_OFFER_TTL_HOURS, type Fish, type GiftOffer, type Tank } from '@aquarium/shared';
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  ACCEPTS_GIFTS_HINT,
  CREATE_BUSY,
  GiftBook,
  checkHandle,
  destinations,
  offerView,
  offersNeedingMe,
  pledgeChoices,
  type Destination,
  type OfferAction,
} from '../sync/gifts';
import type { SessionState, TankSession } from '../sync/session';
import { useApi } from './context';
import { useSpeciesNames } from './session';

const books = new WeakMap<TankSession, GiftBook>();

function useGiftBook(session: TankSession): GiftBook {
  const api = useApi();
  return useMemo(() => {
    const held = books.get(session);
    if (held) return held;
    const book = new GiftBook({
      api,
      onTank: (tank, arrival) => session.applyGiftTank(tank, arrival !== null),
    });
    books.set(session, book);
    return book;
  }, [api, session]);
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

export function AcceptsGiftsToggle({
  session,
  state,
  tank,
}: {
  session: TankSession;
  state: SessionState;
  tank: Tank;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Gifts</h3>
      <label className="row">
        <input
          type="checkbox"
          checked={tank.acceptsGifts}
          disabled={state.busy}
          aria-describedby={`${id}-hint`}
          onChange={(e) => void session.setAcceptsGifts(tank.id, e.target.checked)}
        />
        Accept gifts in {tank.name}
      </label>
      <p id={`${id}-hint`} className="hint">
        {ACCEPTS_GIFTS_HINT}
      </p>
    </section>
  );
}

export function GiftFishButton({
  session,
  tank,
  fish,
}: {
  session: TankSession;
  tank: Tank;
  fish: Fish;
}) {
  const book = useGiftBook(session);
  const bookState = useSyncExternalStore(book.subscribe, book.getState);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [wantsReturn, setWantsReturn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mine = bookState.busy === CREATE_BUSY;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = checkHandle(handle);
    if (!checked.ok) return setProblem(checked.message);
    setProblem(null);
    void book
      .create({
        fromTankId: tank.id,
        fishId: fish.id,
        fishName: fish.name,
        handle: checked.handle,
        wantsReturn,
      })
      .then((ok) => {
        if (ok) setOpen(false);
      });
  };

  return (
    <div className="gift-fish">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-form`}
        onClick={() => {
          if (bookState.busy === null) book.clearMessages();
          setOpen(!open);
        }}
      >
        Gift or trade {fish.name}
      </button>
      {open && (
        <form id={`${id}-form`} onSubmit={submit} className="inline-form" noValidate>
          <label htmlFor={`${id}-handle`}>Player handle</label>
          <input
            id={`${id}-handle`}
            value={handle}
            maxLength={21}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={problem !== null}
            aria-describedby={problem ? `${id}-e` : undefined}
            onChange={(e) => setHandle(e.target.value)}
          />
          <label className="row">
            <input
              type="checkbox"
              checked={wantsReturn}
              onChange={(e) => setWantsReturn(e.target.checked)}
            />
            Ask for a fish in return
          </label>
          <p className="hint">
            {fish.name} leaves your tank now and waits for the other player for{' '}
            {GIFT_OFFER_TTL_HOURS} hours. You can cancel until they answer.
          </p>
          <button type="submit" className="primary" disabled={bookState.busy !== null}>
            {mine ? 'Sending' : `Send ${fish.name}`}
          </button>
          {problem && (
            <p id={`${id}-e`} className="field-error" role="alert">
              {problem}
            </p>
          )}
          {bookState.error && (
            <p className="field-error" role="alert">
              {bookState.error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

function DestinationSelect({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: readonly Destination[];
  value: string;
  onChange(tankId: string): void;
}) {
  const chosen = options.find((o) => o.tank.id === value);
  return (
    <div className="row">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        aria-describedby={chosen?.note ? `${id}-n` : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.tank.id} value={o.tank.id} disabled={!o.usable}>
            {o.tank.name}
            {o.usable ? '' : ' (unavailable)'}
          </option>
        ))}
      </select>
      {chosen?.note && (
        <p id={`${id}-n`} className="hint">
          {chosen.note}
        </p>
      )}
    </div>
  );
}

function OfferItem({
  offer,
  book,
  state,
  busy,
  now,
}: {
  offer: GiftOffer;
  book: GiftBook;
  state: SessionState;
  busy: boolean;
  now: number;
}) {
  const id = useId();
  const names = useSpeciesNames();
  const view = offerView(offer, now, names);
  const incomingFish = offer.role === 'recipient' ? offer.fish : offer.pledged;
  const options = useMemo(
    () => (incomingFish ? destinations(state.tanks, incomingFish, state.species) : []),
    [incomingFish, state.tanks, state.species],
  );
  const pledges = useMemo(() => pledgeChoices(state.tanks), [state.tanks]);
  const firstUsable = options.find((o) => o.usable)?.tank.id ?? '';
  const [tankId, setTankId] = useState<string | null>(null);
  const [pledgeId, setPledgeId] = useState<string | null>(null);
  const toTankId = options.find((o) => o.tank.id === tankId && o.usable)?.tank.id ?? firstUsable;
  const returnFishId =
    pledges.find((p) => p.fish.id === pledgeId)?.fish.id ?? pledges[0]?.fish.id ?? '';

  const needsDestination = view.actions.some(
    (a) => a === 'accept' || a === 'counter' || a === 'confirm',
  );
  const noRoom = needsDestination && toTankId === '';
  const run = (action: OfferAction) => {
    switch (action) {
      case 'accept':
        return void book.accept({ offer, toTankId });
      case 'counter':
        return void book.accept({ offer, toTankId, returnFishId });
      case 'confirm':
        return void book.confirm(offer, toTankId);
      case 'decline':
        return void book.decline(offer);
      case 'cancel':
        return void book.cancel(offer);
    }
  };
  const label = (action: OfferAction): string => {
    switch (action) {
      case 'accept':
        return `Accept ${offer.fish.name}`;
      case 'counter': {
        const pledged = pledges.find((p) => p.fish.id === returnFishId);
        return pledged ? `Offer ${pledged.fish.name} in return` : 'Offer a fish in return';
      }
      case 'confirm':
        return `Confirm the swap for ${offer.pledged?.name ?? 'the new fish'}`;
      case 'decline':
        return offer.status === 'countered' ? 'Decline the whole trade' : 'Decline';
      case 'cancel':
        return 'Cancel offer';
    }
  };

  return (
    <li>
      <p>
        <strong>{view.headline}</strong>
      </p>
      <p className="hint">
        {view.status}
        {view.timeLeft ? ` (${view.timeLeft})` : ''}
      </p>
      {needsDestination &&
        (noRoom ? (
          <p className="hint">
            None of your tanks can take this fish. Turn on &quot;Accept gifts&quot; for a tank with
            the right kind of water.
          </p>
        ) : (
          <>
            <DestinationSelect
              id={`${id}-tank`}
              label={view.actions.includes('confirm') ? 'Receiving tank for the swap' : 'Put it in'}
              options={options}
              value={toTankId}
              onChange={setTankId}
            />
            {view.actions.includes('counter') && (
              <div className="row">
                <label htmlFor={`${id}-pledge`}>Fish to offer back</label>
                <select
                  id={`${id}-pledge`}
                  value={returnFishId}
                  onChange={(e) => setPledgeId(e.target.value)}
                >
                  {pledges.map((p) => (
                    <option key={p.fish.id} value={p.fish.id}>
                      {p.fish.name} ({p.tank.name})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        ))}
      {view.actions.length > 0 && (
        <div className="care-actions">
          {view.actions.map((action) => {
            const primary = action === 'accept' || action === 'counter' || action === 'confirm';
            const unusable = primary && (noRoom || (action === 'counter' && returnFishId === ''));
            return (
              <button
                key={action}
                type="button"
                className={primary ? 'primary' : undefined}
                disabled={busy || unusable}
                onClick={() => run(action)}
              >
                {label(action)}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

function OfferGroup({
  title,
  offers,
  book,
  state,
  busyId,
  now,
}: {
  title: string;
  offers: readonly GiftOffer[];
  book: GiftBook;
  state: SessionState;
  busyId: string | null;
  now: number;
}) {
  return (
    <section aria-label={title}>
      <h4>{title}</h4>
      {offers.length === 0 ? (
        <p className="hint">None.</p>
      ) : (
        <ul className="shop">
          {offers.map((o) => (
            <OfferItem
              key={o.id}
              offer={o}
              book={book}
              state={state}
              busy={busyId !== null}
              now={now}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function GiftNotice({ session }: { session: TankSession }) {
  const book = useGiftBook(session);
  useEffect(() => () => book.clearMessages(), [book]);
  const bookState = useSyncExternalStore(book.subscribe, book.getState);
  return <div role="status">{bookState.notice}</div>;
}

export function GiftOffers({ session, state }: { session: TankSession; state: SessionState }) {
  const book = useGiftBook(session);
  const bookState = useSyncExternalStore(book.subscribe, book.getState);
  const now = useNow(60_000);
  const heading = useId();

  useEffect(() => {
    void book.refresh();
    return () => book.clearMessages();
  }, [book]);

  const waiting = offersNeedingMe(bookState.offers, now);
  return (
    <section aria-labelledby={heading} className="block">
      <h3 id={heading}>Offers{waiting > 0 ? ` (${waiting} waiting for you)` : ''}</h3>
      <p className="hint">
        Fish sent to you or by you. Players are named by handle only, and an offer runs out after{' '}
        {GIFT_OFFER_TTL_HOURS} hours.
      </p>
      <div className="row">
        <button type="button" disabled={bookState.loading} onClick={() => void book.refresh()}>
          {bookState.loading ? 'Refreshing' : 'Refresh offers'}
        </button>
      </div>
      <div role="status">{bookState.notice}</div>
      {bookState.error && (
        <p className="field-error" role="alert">
          {bookState.error}
        </p>
      )}
      {bookState.offers && (
        <>
          <OfferGroup
            title="Incoming offers"
            offers={bookState.offers.incoming}
            book={book}
            state={state}
            busyId={bookState.busy}
            now={now}
          />
          <OfferGroup
            title="Outgoing offers"
            offers={bookState.offers.outgoing}
            book={book}
            state={state}
            busyId={bookState.busy}
            now={now}
          />
        </>
      )}
    </section>
  );
}
