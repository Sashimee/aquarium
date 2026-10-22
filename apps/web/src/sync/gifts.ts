import {
  GIFT_OFFER_TTL_HOURS,
  handleFormatSchema,
  type Fish,
  type GiftArrival,
  type GiftFish,
  type GiftListResponse,
  type GiftOffer,
  type GiftStatus,
  type SpeciesSummary,
  type Tank,
} from '@aquarium/shared';
import { ApiRequestError, type ApiClient } from '../ui/api';
import { IntentKeys, outcomeUnknown } from './intentKeys';
import { canBuy, speciesName, type SpeciesNames } from './life';
import { describeSyncError } from './messages';

export const ACCEPTS_GIFTS_HINT =
  'Off by default. While it is on, other players can send fish into this tank. Fish you send out never need it.';

export type OfferAction = 'accept' | 'counter' | 'decline' | 'confirm' | 'cancel';

export interface OfferView {
  headline: string;
  status: string;
  actions: OfferAction[];
  settled: boolean;
  timeLeft: string | null;
}

export type HandleCheck = { ok: true; handle: string } | { ok: false; message: string };

export function checkHandle(raw: string): HandleCheck {
  const handle = raw.trim().replace(/^@/, '').toLowerCase();
  if (handle === '') return { ok: false, message: 'Enter the handle of the player to send to.' };
  if (!handleFormatSchema.safeParse(handle).success) {
    return {
      ok: false,
      message:
        'A handle is 3 to 20 lowercase letters, digits or underscores, starting with a letter.',
    };
  }
  return { ok: true, handle };
}

export function giftableFish(tank: Tank): Fish[] {
  return tank.fish.filter((f) => f.status === 'alive');
}

/** A past-expiry offer the server has not yet settled is shown as expired and offers no action. */
export function effectiveStatus(offer: GiftOffer, now: number): GiftStatus {
  const live = offer.status === 'open' || offer.status === 'countered';
  return live && Date.parse(offer.expiresAt) <= now ? 'expired' : offer.status;
}

export function timeLeftText(expiresAt: string, now: number): string {
  const hours = (Date.parse(expiresAt) - now) / 3_600_000;
  if (hours <= 0) return 'expired';
  if (hours < 1) return 'less than an hour left';
  if (hours < 48) {
    const rounded = Math.round(hours);
    return `about ${rounded} ${rounded === 1 ? 'hour' : 'hours'} left`;
  }
  return `about ${Math.round(hours / 24)} days left`;
}

const handleText = (counterpart: string | null): string =>
  counterpart === null ? 'a player who has left' : `@${counterpart}`;

const fishText = (fish: GiftFish, names: SpeciesNames): string =>
  `${fish.name} the ${speciesName(names, fish.species)}`;

export function offerView(offer: GiftOffer, now: number, names: SpeciesNames): OfferView {
  const status = effectiveStatus(offer, now);
  const other = handleText(offer.counterpart);
  const incoming = offer.role === 'recipient';
  const kind = offer.wantsReturn ? 'trade' : 'gift';
  const headline = incoming
    ? `${other} offers you ${fishText(offer.fish, names)} as a ${kind}`
    : `Your ${fishText(offer.fish, names)}, offered to ${other} as a ${kind}`;
  const settled = status !== 'open' && status !== 'countered';
  const base = { headline, settled, timeLeft: settled ? null : timeLeftText(offer.expiresAt, now) };
  const back = `${offer.fish.name} is back in your tank.`;

  switch (status) {
    case 'open':
      if (incoming) {
        return {
          ...base,
          status: offer.wantsReturn
            ? `${other} wants a fish in return. Choose one of yours to offer back.`
            : 'Waiting for your answer.',
          actions: [offer.wantsReturn ? 'counter' : 'accept', 'decline'],
        };
      }
      return { ...base, status: `Waiting for ${other} to answer.`, actions: ['cancel'] };
    case 'countered':
      if (incoming) {
        return {
          ...base,
          status: `You offered ${offer.pledged ? offer.pledged.name : 'a fish'} back. Waiting for ${other} to confirm the swap. Your fish stays in your tank until then. Declining ends the whole trade and sends ${offer.fish.name} back to ${other}.`,
          actions: ['decline'],
        };
      }
      return offer.pledged
        ? {
            ...base,
            status: `${other} offers ${fishText(offer.pledged, names)} in return. Confirm to swap both fish.`,
            actions: ['confirm', 'cancel'],
          }
        : {
            ...base,
            status: `The fish ${other} offered in return is no longer available. Cancel to get ${offer.fish.name} back.`,
            actions: ['cancel'],
          };
    case 'accepted':
      return {
        ...base,
        status: incoming
          ? `Accepted. ${offer.fish.name} joined your tank.`
          : `Accepted by ${other}. ${offer.fish.name} now lives with them.`,
        actions: [],
      };
    case 'declined':
      return {
        ...base,
        status: incoming ? 'You declined this offer.' : `${other} declined. ${back}`,
        actions: [],
      };
    case 'cancelled':
      return {
        ...base,
        status: incoming ? `${other} withdrew the offer.` : `You cancelled this offer. ${back}`,
        actions: [],
      };
    case 'expired':
      return {
        ...base,
        status: incoming
          ? `Expired after ${GIFT_OFFER_TTL_HOURS} hours with no answer.`
          : `Expired after ${GIFT_OFFER_TTL_HOURS} hours with no answer. ${back}`,
        actions: [],
      };
  }
}

/** Offers that wait for the player: a fresh incoming one, or a counter the player must confirm. */
export function offersNeedingMe(list: GiftListResponse | null, now: number): number {
  if (!list) return 0;
  return [...list.incoming, ...list.outgoing].filter((o) => {
    const status = effectiveStatus(o, now);
    return (
      (o.role === 'recipient' && status === 'open') ||
      (o.role === 'sender' && status === 'countered')
    );
  }).length;
}

export interface Destination {
  tank: Tank;
  usable: boolean;
  note: string | null;
}

/** A full tank is only a warning: a swap may free the room, and the server has the last word. */
export function destinations(
  tanks: readonly Tank[],
  fish: GiftFish,
  species: readonly SpeciesSummary[],
): Destination[] {
  const summary = species.find((s) => s.id === fish.species);
  return tanks.map((tank) => {
    if (!tank.acceptsGifts) {
      return { tank, usable: false, note: 'Not accepting gifts. Turn it on in Tanks first.' };
    }
    if (summary && summary.biome !== tank.biome) {
      return { tank, usable: false, note: `${summary.commonName} needs a ${summary.biome} tank.` };
    }
    const verdict = summary ? canBuy(tank, summary, species) : { ok: true as const };
    return { tank, usable: true, note: verdict.ok ? null : verdict.reason };
  });
}

export interface PledgeChoice {
  fish: Fish;
  tank: Tank;
}

export function pledgeChoices(tanks: readonly Tank[]): PledgeChoice[] {
  return tanks.flatMap((tank) => giftableFish(tank).map((fish) => ({ fish, tank })));
}

export type GiftOp = 'create' | 'accept' | 'confirm' | 'decline' | 'cancel';

export interface GiftRefusalContext {
  op: GiftOp;
  handle?: string;
}

export function giftRefusalText(error: unknown, ctx: GiftRefusalContext): string {
  if (!(error instanceof ApiRequestError)) return describeSyncError(error);
  if (error.status === 404 && ctx.op !== 'create') {
    return 'That offer no longer exists. The list has been refreshed.';
  }
  if (error.status === 404 || error.status === 400) return error.message;
  if (error.status !== 409) return describeSyncError(error);
  switch (error.reason) {
    case 'gifts_closed':
      if (ctx.op === 'create') {
        return `${ctx.handle ? `@${ctx.handle} is` : 'That player is'} not taking gifts right now. Players choose which of their tanks accept fish, and none of theirs does.`;
      }
      return ctx.op === 'confirm'
        ? 'One of the two tanks is not accepting gifts. Turn on "Accept gifts" for it in Tanks, or pick another tank.'
        : 'That tank is not accepting gifts. Turn on "Accept gifts" for it in Tanks, or pick another tank.';
    case 'offer_changed':
      return 'The offer changed while you were confirming. The list has been refreshed.';
    case 'offer_closed':
      return 'This offer was already settled. The list has been refreshed.';
    case 'offer_expired':
      return `This offer ran out after ${GIFT_OFFER_TTL_HOURS} hours. The fish went back to its owner.`;
    case 'too_many_offers':
      return 'Too many offers are open. Wait for some to be answered, or cancel one.';
    case 'fish_unavailable':
      return 'The fish offered in return is no longer available. Cancel the offer to get your fish back.';
    case 'fish_dead':
      return 'A fish that has died cannot be gifted or traded. Net it from the tank instead.';
    case 'wrong_biome':
      return 'That tank holds a different kind of water than this fish needs. Pick another tank.';
    case 'tank_full':
      return 'That tank has no room. Make space there or pick another tank.';
    case 'key_reused':
      return 'That request clashed with an earlier one. Press the button again.';
    default:
      return error.message;
  }
}

export interface GiftBookState {
  offers: GiftListResponse | null;
  loading: boolean;
  busy: string | null;
  error: string | null;
  notice: string | null;
}

export const INITIAL_GIFT_BOOK: GiftBookState = {
  offers: null,
  loading: false,
  busy: null,
  error: null,
  notice: null,
};

export const CREATE_BUSY = 'create';

export interface GiftBookDeps {
  api: Pick<
    ApiClient,
    'gifts' | 'createGift' | 'acceptGift' | 'confirmGift' | 'declineGift' | 'cancelGift'
  >;
  /** Hands a tank the server changed to the session; `arrival` is set when a fish joined it. */
  onTank(tank: Tank, arrival: GiftArrival | null): void;
  newKey?: () => string;
}

export interface CreateInput {
  fromTankId: string;
  fishId: string;
  fishName: string;
  handle: string;
  wantsReturn: boolean;
}

export interface AcceptInput {
  offer: GiftOffer;
  toTankId: string;
  returnFishId?: string;
}

/** Offers and the calls that move them. One key per intent, kept while the outcome is unknown. */
export class GiftBook {
  private state: GiftBookState = INITIAL_GIFT_BOOK;
  private readonly listeners = new Set<() => void>();
  private readonly keys: IntentKeys;
  private disposed = false;
  private refreshSeq = 0;

  constructor(private readonly deps: GiftBookDeps) {
    this.keys = new IntentKeys(deps.newKey);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): GiftBookState => this.state;

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  clearMessages(): void {
    this.patch({ error: null, notice: null });
  }

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    this.patch({ loading: true });
    try {
      const offers = await this.deps.api.gifts();
      if (seq !== this.refreshSeq) return;
      this.patch({ offers, loading: false });
    } catch (error) {
      if (seq !== this.refreshSeq) return;
      this.patch({ loading: false, error: describeSyncError(error) });
    }
  }

  create(input: CreateInput): Promise<boolean> {
    const intent = `create:${input.fromTankId}:${input.fishId}:${input.handle}:${input.wantsReturn}`;
    return this.run(CREATE_BUSY, intent, { op: 'create', handle: input.handle }, async (key) => {
      const result = await this.deps.api.createGift({
        fromTankId: input.fromTankId,
        fishId: input.fishId,
        toHandle: input.handle,
        wantsReturn: input.wantsReturn,
        idempotencyKey: key,
      });
      this.deps.onTank(result.tank, null);
      return `${input.fishName} is on its way to @${input.handle}. You can cancel until they answer.`;
    });
  }

  accept(input: AcceptInput): Promise<boolean> {
    const { offer } = input;
    const intent = `accept:${offer.id}:${input.toTankId}:${input.returnFishId ?? ''}`;
    return this.run(offer.id, intent, { op: 'accept' }, async (key) => {
      const result = await this.deps.api.acceptGift(offer.id, {
        toTankId: input.toTankId,
        ...(input.returnFishId ? { returnFishId: input.returnFishId } : {}),
        idempotencyKey: key,
      });
      this.deps.onTank(result.tank, result.arrival);
      return result.arrival
        ? `${offer.fish.name} joined your tank and is getting used to the water.`
        : `Your fish is offered back. ${offer.fish.name} arrives once ${handleText(offer.counterpart)} confirms.`;
    });
  }

  confirm(offer: GiftOffer, toTankId: string): Promise<boolean> {
    return this.run(offer.id, `confirm:${offer.id}:${toTankId}`, { op: 'confirm' }, async (key) => {
      const result = await this.deps.api.confirmGift(offer.id, { toTankId, idempotencyKey: key });
      this.deps.onTank(result.tank, result.arrival);
      return `Swapped. ${offer.pledged?.name ?? 'The new fish'} joined your tank and is getting used to the water.`;
    });
  }

  decline(offer: GiftOffer): Promise<boolean> {
    return this.run(offer.id, null, { op: 'decline' }, async () => {
      await this.deps.api.declineGift(offer.id);
      return 'Offer declined.';
    });
  }

  cancel(offer: GiftOffer): Promise<boolean> {
    return this.run(offer.id, null, { op: 'cancel' }, async () => {
      const result = await this.deps.api.cancelGift(offer.id);
      this.deps.onTank(result.tank, null);
      return `Offer cancelled. ${offer.fish.name} is back in your tank.`;
    });
  }

  private async run(
    busy: string,
    intent: string | null,
    ctx: GiftRefusalContext,
    call: (key: string) => Promise<string>,
  ): Promise<boolean> {
    if (this.state.busy !== null) return false;
    const key = intent === null ? '' : this.keys.keyFor(intent);
    this.patch({ busy, error: null, notice: null });
    try {
      const notice = await call(key);
      if (intent !== null) this.keys.settle(intent);
      this.patch({ busy: null, notice });
      await this.refresh();
      return true;
    } catch (error) {
      if (intent !== null && !outcomeUnknown(error)) this.keys.settle(intent);
      this.patch({ busy: null, error: giftRefusalText(error, ctx) });
      if (staleOffer(error)) await this.refresh();
      return false;
    }
  }

  private patch(next: Partial<GiftBookState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
}

function staleOffer(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.status === 404 ||
      error.reason === 'offer_closed' ||
      error.reason === 'offer_expired' ||
      error.reason === 'offer_changed')
  );
}
