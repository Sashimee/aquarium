import {
  COMMUNITY_HEARTBEAT_MS,
  communityEventSchema,
  communityStreamStateSchema,
  communityViewersSchema,
  type CauseOfDeath,
  type CommunityEvent,
  type CommunityQuota,
  type CommunityState,
  type CommunityStreamState,
  type FoodType,
  type Tank,
} from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import {
  ApiRequestError,
  REQUEST_TIMEOUT_MS,
  TOTAL_TIMEOUT_FACTOR,
  type ApiClient,
} from '../ui/api';
import { AteUploader, type AteUploaderOptions } from './ateUploader';
import { backoffDelay, realSleep } from './backoff';
import { bundledCommonName } from './bundledSpecies';
import type { OpenStream, SseFrame } from './communityStream';
import { IntentKeys, outcomeUnknown } from './intentKeys';
import { diffFish, isStaleSnapshot } from './reconcile';

export type Connection = 'connecting' | 'live' | 'reconnecting';

export type FeedProblemNeeds = 'sign-in' | 'verify' | null;

export interface FeedProblem {
  text: string;
  /** Epoch ms from the injected clock at which feeding may be tried again, or null when waiting does not help. */
  retryAt: number | null;
  needs: FeedProblemNeeds;
}

export interface FeedLine {
  id: number;
  at: string;
  text: string;
}

export interface CommunityViewState {
  connection: Connection;
  /** When the next reconnect attempt starts, while `connection` is `reconnecting`. */
  reconnectAt: number | null;
  streamProblem: string | null;
  tank: Tank | null;
  viewers: number;
  tankFeedRemaining: number | null;
  quota: CommunityQuota | null;
  lines: readonly FeedLine[];
  feeding: boolean;
  problem: FeedProblem | null;
  notice: string | null;
}

export const INITIAL_COMMUNITY_STATE: CommunityViewState = {
  connection: 'connecting',
  reconnectAt: null,
  streamProblem: null,
  tank: null,
  viewers: 0,
  tankFeedRemaining: null,
  quota: null,
  lines: [],
  feeding: false,
  problem: null,
  notice: null,
};

export const MAX_FEED_LINES = 12;
// At least the POST's overall deadline (REQUEST_TIMEOUT_MS x TOTAL_TIMEOUT_FACTOR), or a slow reply outlives its echo.
const ECHO_WINDOW_MS = REQUEST_TIMEOUT_MS * TOTAL_TIMEOUT_FACTOR + 5_000;
const PORTION_EPSILON = 1e-6;
const QUOTA_REFRESH_SLACK_MS = 1_000;
export const STREAM_BACKOFF = { baseMs: 1_000, maxMs: 30_000 } as const;

const FOOD_NAME: Record<FoodType, string> = {
  flakes: 'flakes',
  pellets: 'pellets',
  bloodworms: 'bloodworms',
  'brine-shrimp': 'brine shrimp',
  nori: 'nori',
  'algae-wafer': 'an algae wafer',
};

const CAUSE_TEXT: Record<CauseOfDeath, string> = {
  starvation: 'went hungry',
  ammonia: 'was poisoned by ammonia',
  nitrite: 'was poisoned by nitrite',
  disease: 'fell ill',
  water_quality: 'suffered in poor water',
  old_age: 'died of old age',
  unknown: 'died',
};

export function eventText(event: CommunityEvent): string {
  switch (event.type) {
    case 'feed':
      return `${event.by ?? 'Someone'} fed ${FOOD_NAME[event.food]}.`;
    case 'death':
      return `${event.name} the ${bundledCommonName(event.species).toLowerCase()} ${CAUSE_TEXT[event.cause]}.`;
    case 'born':
      return `${event.name}, a young ${bundledCommonName(event.species).toLowerCase()}, was born.`;
  }
}

export function secondsLeft(retryAt: number | null, now: number): number {
  return retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
}

export function waitText(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function portionsText(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}`;
}

export function quotaText(
  quota: CommunityQuota | null,
  tankFeedRemaining: number | null,
): { mine: string | null; tank: string | null } {
  return {
    mine: quota
      ? `You can still feed ${portionsText(quota.remaining)} of ${portionsText(quota.limit)} portions.`
      : null,
    tank:
      tankFeedRemaining === null
        ? null
        : tankFeedRemaining <= 0
          ? 'The fish are full for now.'
          : `The tank still takes ${portionsText(tankFeedRemaining)} portions.`,
  };
}

export function feedProblem(error: unknown, now: number): FeedProblem {
  if (!(error instanceof ApiRequestError)) {
    return {
      text: 'The food was not dropped. Try again in a moment.',
      retryAt: null,
      needs: null,
    };
  }
  const retryAt = error.retryAfterSeconds === null ? null : now + error.retryAfterSeconds * 1_000;
  if (error.status === 401) {
    return { text: 'Sign in to feed the community tank.', retryAt: null, needs: 'sign-in' };
  }
  if (error.status === 403) {
    return error.code === 'email_not_verified'
      ? {
          text: 'Verify your email address to feed the community tank.',
          retryAt: null,
          needs: 'verify',
        }
      : { text: error.message, retryAt: null, needs: null };
  }
  if (error.status === 409) {
    return {
      text: 'That feeding clashed with an earlier one. Press the button again.',
      retryAt: null,
      needs: null,
    };
  }
  if (error.status === 422) {
    return {
      text: 'The fish cannot take that food right now. Wait for them to finish eating.',
      retryAt: null,
      needs: null,
    };
  }
  if (error.status === 429) {
    return error.code === 'quota_exceeded'
      ? { text: error.message, retryAt, needs: null }
      : { text: 'Feeding too often.', retryAt, needs: null };
  }
  if (error.code === 'network' || error.code === 'timeout') {
    return {
      text: 'Could not reach the server. Press the button again; the food will not be doubled.',
      retryAt: null,
      needs: null,
    };
  }
  return { text: error.message, retryAt, needs: null };
}

export function streamProblemText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'The live connection to the community tank was lost.';
}

type SceneBus = Pick<EventBus<InteractionEvents>, 'emit'>;

/** Puts the first snapshot into the scene whole and every later one in as a diff, so fish do not pop. */
export function applyTankToScene(bus: SceneBus, held: Tank | null, next: Tank): void {
  if (!held) {
    bus.emit('tank:loaded', {
      tankId: next.id,
      biome: next.biome,
      size: next.size,
      fish: next.fish,
      decorLayout: next.decorLayout,
      decorEdited: next.decorEdited,
      backgroundId: next.backgroundId,
      recentVisitDays: 0,
    });
    bus.emit('tank:water', { tankId: next.id, water: next.water });
    bus.emit('tank:plants', { tankId: next.id, plants: next.plants ?? [] });
    bus.emit('tank:wave-maker', { tankId: next.id, tier: next.equipment.waveMaker.tier });
    bus.emit('tank:lamp', {
      tankId: next.id,
      onHour: next.equipment.light.onHour,
      offHour: next.equipment.light.offHour,
    });
    return;
  }
  const tankId = next.id;
  const diff = diffFish(held.fish, next.fish);
  for (const fish of diff.removed)
    bus.emit('tank:fish-removed', { tankId, fishId: fish.id, reason: 'gone' });
  for (const fish of diff.added) bus.emit('tank:fish-added', { tankId, fish, acclimate: false });
  for (const fish of diff.died) bus.emit('tank:fish-died', { tankId, fish });
  if (diff.updated.length > 0) bus.emit('tank:fish-updated', { tankId, fish: diff.updated });
  if (held.water !== next.water) bus.emit('tank:water', { tankId, water: next.water });
}

export interface CommunityControllerDeps {
  api: Pick<ApiClient, 'community' | 'communityFeed' | 'communityAte'> &
    Partial<Pick<ApiClient, 'myHandle'>>;
  openStream: OpenStream;
  /** Applies a tank snapshot to the scene; called only for snapshots newer than the one held. */
  onTank?(held: Tank | null, next: Tank): void;
  /** Food to drop into the scene: the player's own feed once the server took it, and other people's. */
  onDrop?(food: FoodType, portion: number): void;
  now?: () => number;
  heartbeatMs?: number;
  random?: () => number;
  ateOptions?: Partial<AteUploaderOptions>;
}

interface Echo {
  food: FoodType;
  portion: number;
  until: number;
  /** The food of this feed is already in the water, whichever of the stream frame and the reply came first. */
  dropped: boolean;
}

/** The client side of the shared tank: one live stream, the player's quota, and feeding with retry-safe keys. */
export class CommunityController {
  private state: CommunityViewState = INITIAL_COMMUNITY_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly keys = new IntentKeys();
  private readonly lifetime = new AbortController();
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private echoes: Echo[] = [];
  private lineId = 0;
  private quotaTimer: ReturnType<typeof setTimeout> | null = null;
  private uploader: AteUploader | null = null;
  private started = false;
  private handle: string | null | undefined = undefined;

  constructor(private readonly deps: CommunityControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.heartbeatMs = deps.heartbeatMs ?? COMMUNITY_HEARTBEAT_MS;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): CommunityViewState => this.state;

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refreshQuota();
    void this.loadHandle();
    void this.runStream();
  }

  dispose(): void {
    this.lifetime.abort();
    if (this.quotaTimer) clearTimeout(this.quotaTimer);
    this.quotaTimer = null;
    const uploader = this.uploader;
    this.uploader = null;
    if (uploader) void uploader.flushNow().finally(() => uploader.dispose());
    this.listeners.clear();
  }

  async feed(food: FoodType, portion: number): Promise<void> {
    if (this.state.feeding) return;
    const { problem } = this.state;
    if (problem && secondsLeft(problem.retryAt, this.now()) > 0) return;
    const intent = `${food}:${portion}`;
    this.patch({ feeding: true, problem: null, notice: null });
    const echo: Echo = {
      food,
      portion,
      until: this.now() + ECHO_WINDOW_MS,
      dropped: false,
    };
    this.echoes.push(echo);
    try {
      const response = await this.deps.api.communityFeed({
        food,
        portion,
        idempotencyKey: this.keys.keyFor(intent),
      });
      this.keys.settle(intent);
      if (this.lifetime.signal.aborted) return;
      this.applyState(response.state);
      this.patch({
        notice: response.replayed
          ? 'That feeding had already gone through.'
          : 'Fed. Watch them come up.',
      });
      if (response.replayed || echo.dropped) {
        this.forgetEcho(echo);
      } else {
        echo.dropped = true;
        this.deps.onDrop?.(food, portion);
      }
    } catch (error) {
      this.forgetEcho(echo);
      if (this.lifetime.signal.aborted) return;
      if (!outcomeUnknown(error)) this.keys.settle(intent);
      this.patch({ problem: feedProblem(error, this.now()) });
    } finally {
      if (!this.lifetime.signal.aborted) this.patch({ feeding: false });
    }
  }

  reportAte(eaten: readonly { fishId: string; portion: number }[]): void {
    if (this.state.quota === null || this.lifetime.signal.aborted) return;
    const uploader = (this.uploader ??= new AteUploader({
      ...this.deps.ateOptions,
      send: async (reports, batchId) => {
        this.applyState(await this.deps.api.communityAte(reports, batchId));
      },
      onDropped: (reason, reports, cause) => {
        if (reason === 'rejected') return;
        console.warn(`dropped ${reports.length} eating reports (${reason})`, cause);
      },
    }));
    for (const e of eaten) uploader.add(e.fishId, e.portion);
  }

  /** Own feeds are matched on the handle the server publishes; without one the frame carries null. */
  private async loadHandle(): Promise<void> {
    try {
      const handle = await this.deps.api.myHandle?.();
      if (handle !== undefined && !this.lifetime.signal.aborted) this.handle = handle;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        if (!this.lifetime.signal.aborted) this.handle = null;
        return;
      }
      console.warn(
        'could not load your handle; matching own feeds on food and portion only',
        error,
      );
    }
  }

  async refreshQuota(): Promise<void> {
    try {
      const state = await this.deps.api.community();
      if (!this.lifetime.signal.aborted) this.applyState(state);
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      this.patch({
        notice:
          error instanceof ApiRequestError
            ? error.message
            : 'Could not load your feeding allowance.',
      });
    }
  }

  private async runStream(): Promise<void> {
    const signal = this.lifetime.signal;
    let attempt = 0;
    while (!signal.aborted) {
      const connection = new AbortController();
      let silentTimer: ReturnType<typeof setTimeout> | null = null;
      let silent = false;
      const arm = () => {
        if (silentTimer) clearTimeout(silentTimer);
        silentTimer = setTimeout(() => {
          silent = true;
          connection.abort();
        }, this.heartbeatMs * 2);
      };
      const stop = () => connection.abort();
      signal.addEventListener('abort', stop, { once: true });
      arm();
      let failure: unknown = null;
      try {
        await this.deps.openStream({
          signal: connection.signal,
          onFrame: (frame) => {
            arm();
            if (this.handleFrame(frame)) attempt = 0;
          },
        });
      } catch (error) {
        failure = error;
      } finally {
        if (silentTimer) clearTimeout(silentTimer);
        signal.removeEventListener('abort', stop);
      }
      if (signal.aborted) return;
      const cause = silent
        ? new ApiRequestError(
            0,
            'timeout',
            'The community tank went quiet, so the connection was restarted.',
          )
        : failure;
      const refused = cause instanceof ApiRequestError ? cause.retryAfterSeconds : null;
      const computed = backoffDelay(attempt, {
        ...STREAM_BACKOFF,
        ...(this.deps.random ? { random: this.deps.random } : {}),
      });
      const delay = Math.max(computed, (refused ?? 0) * 1_000);
      attempt++;
      this.patch({
        connection: 'reconnecting',
        reconnectAt: this.now() + delay,
        streamProblem: cause === null ? null : streamProblemText(cause),
      });
      try {
        await realSleep(delay, signal);
      } catch {
        return;
      }
      this.patch({ connection: 'connecting', reconnectAt: null });
      void this.refreshQuota();
    }
  }

  /** True once the stream has delivered state, which is what proves a connection worked. */
  private handleFrame(frame: SseFrame): boolean {
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      console.warn(`ignored a community frame that is not JSON (${frame.event})`);
      return false;
    }
    switch (frame.event) {
      case 'state': {
        const state = communityStreamStateSchema.safeParse(payload);
        if (!state.success) return this.ignored(frame.event);
        this.applyState(state.data);
        this.patch({ connection: 'live', reconnectAt: null, streamProblem: null });
        return true;
      }
      case 'viewers': {
        const viewers = communityViewersSchema.safeParse(payload);
        if (!viewers.success) return this.ignored(frame.event);
        this.patch({ viewers: viewers.data.viewers });
        return false;
      }
      case 'feed':
      case 'death':
      case 'born': {
        const event = communityEventSchema.safeParse(payload);
        if (!event.success || event.data.type !== frame.event) return this.ignored(frame.event);
        this.addLine(event.data);
        if (event.data.type === 'feed') this.dropFromStream(event.data);
        return false;
      }
      default:
        return false;
    }
  }

  private ignored(event: string): false {
    console.warn(`ignored a malformed community frame (${event})`);
    return false;
  }

  /** The server sends the stream frame before the reply, so an own feed is matched against the pending echo, not a finished one. */
  private dropFromStream(event: Extract<CommunityEvent, { type: 'feed' }>): void {
    const now = this.now();
    this.echoes = this.echoes.filter((e) => e.until > now);
    const echo = this.echoes.find(
      (e) =>
        (this.handle === undefined || this.handle === event.by) &&
        e.food === event.food &&
        Math.abs(e.portion - event.portion) < PORTION_EPSILON,
    );
    if (echo?.dropped) {
      this.forgetEcho(echo);
      return;
    }
    if (echo) echo.dropped = true;
    this.deps.onDrop?.(event.food, event.portion);
  }

  private forgetEcho(echo: Echo): void {
    this.echoes = this.echoes.filter((e) => e !== echo);
  }

  private addLine(event: CommunityEvent): void {
    const line = { id: ++this.lineId, at: event.at, text: eventText(event) };
    this.patch({ lines: [line, ...this.state.lines].slice(0, MAX_FEED_LINES) });
  }

  private applyState(incoming: CommunityStreamState | CommunityState): void {
    if (this.lifetime.signal.aborted) return;
    const held = this.state.tank;
    const fresh = !isStaleSnapshot(held ?? undefined, incoming.tank);
    if (fresh) this.deps.onTank?.(held, incoming.tank);
    const next: Partial<CommunityViewState> = fresh
      ? {
          tank: incoming.tank,
          viewers: incoming.viewers,
          tankFeedRemaining: incoming.tankFeedRemaining,
        }
      : {};
    if ('quota' in incoming) {
      next.quota = incoming.quota;
      this.scheduleQuotaRefresh(incoming.quota);
    }
    this.patch(next);
  }

  private scheduleQuotaRefresh(quota: CommunityQuota | null): void {
    if (this.quotaTimer) clearTimeout(this.quotaTimer);
    this.quotaTimer = null;
    if (!quota?.resetsAt || this.lifetime.signal.aborted) return;
    const wait = Date.parse(quota.resetsAt) - this.now() + QUOTA_REFRESH_SLACK_MS;
    this.quotaTimer = setTimeout(
      () => void this.refreshQuota(),
      // setTimeout stores a 32-bit delay, and a day-long window fits, but a bad clock must not spin.
      Math.min(Math.max(wait, 5_000), 2 ** 31 - 1),
    );
  }

  private patch(change: Partial<CommunityViewState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }
}
