import type {
  AwaySummary,
  Biome,
  CareAction,
  FoodType,
  SpeciesSummary,
  Tank,
  User,
} from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import type { ApiClient } from '../ui/api';
import { AteUploader, type AteUploaderOptions } from './ateUploader';
import { withRetry, realSleep, type Sleep } from './backoff';
import { ACCLIMATION_SECONDS, shouldShowAway } from './life';
import { describeSyncError } from './messages';
import { diffFish, isStaleSnapshot, upsertTank } from './reconcile';

export type SessionPhase = 'anonymous' | 'unverified' | 'loading' | 'ready' | 'offline';

export interface BaggedFish {
  fishId: string;
  name: string;
  releaseAtMs: number;
}

export interface SessionState {
  phase: SessionPhase;
  tanks: readonly Tank[];
  activeId: string | null;
  species: readonly SpeciesSummary[];
  /** Server-reported catch-up for tanks the player has not yet been told about. */
  awayByTank: Readonly<Record<string, AwaySummary>>;
  bagged: readonly BaggedFish[];
  busy: boolean;
  error: string | null;
  notice: string | null;
}

export interface SessionDeps {
  api: ApiClient;
  interaction: EventBus<InteractionEvents>;
  now?: () => number;
  sleep?: Sleep;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  ateOptions?: Omit<AteUploaderOptions, 'send' | 'onDropped'>;
  /** Visible-again refreshes only run after this long, matching the server's 10 minute step. */
  refreshAfterMs?: number;
}

const ACTIVE_KEY = 'aquarium.activeTank';
const LOAD_ATTEMPTS = 4;

const INITIAL: SessionState = {
  phase: 'anonymous',
  tanks: [],
  activeId: null,
  species: [],
  awayByTank: {},
  bagged: [],
  busy: false,
  error: null,
  notice: null,
};

export class TankSession {
  private state: SessionState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private uploader: AteUploader | null = null;
  private lastRefreshMs = 0;
  private loadId = 0;
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stopListening: (() => void)[];
  private readonly now: () => number;
  private readonly sleep: Sleep;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? realSleep;
    this.stopListening = [
      deps.interaction.on('feed:dropped', ({ food, portion }) => void this.feed(food, portion)),
      deps.interaction.on('food:ate', ({ eaten }) => {
        for (const e of eaten) this.uploader?.add(e.fishId, e.portion);
      }),
      deps.interaction.on('net:tap', ({ fishId }) => void this.net(fishId)),
    ];
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): SessionState => this.state;

  get activeTank(): Tank | null {
    return this.state.tanks.find((t) => t.id === this.state.activeId) ?? null;
  }

  dispose(): void {
    for (const off of this.stopListening) off();
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    this.uploader?.dispose();
    this.uploader = null;
    this.listeners.clear();
  }

  /** Call whenever the signed-in user changes. Anonymous visitors keep the demo tank only. */
  async setUser(user: Pick<User, 'emailVerified'> | null): Promise<void> {
    if (!user) return this.reset('anonymous');
    if (!user.emailVerified) return this.reset('unverified');
    await this.load();
  }

  async load(): Promise<void> {
    const id = ++this.loadId;
    this.patch({ phase: 'loading', error: null });
    try {
      const [species, tanks] = await withRetry(
        () => Promise.all([this.deps.api.species(), this.deps.api.tanks()]),
        { maxAttempts: LOAD_ATTEMPTS, sleep: this.sleep },
      );
      if (id !== this.loadId) return;
      this.lastRefreshMs = this.now();
      const awayByTank: Record<string, AwaySummary> = {};
      for (const t of tanks) if (shouldShowAway(t.away)) awayByTank[t.id] = t.away;
      const stored = this.deps.storage?.getItem(ACTIVE_KEY) ?? null;
      const activeId = tanks.find((t) => t.id === stored)?.id ?? tanks[0]?.id ?? null;
      this.patch({ phase: 'ready', species, tanks, awayByTank, activeId });
      if (activeId) this.activate(activeId);
    } catch (error) {
      if (id !== this.loadId) return;
      this.patch({ phase: 'offline', error: describeSyncError(error) });
    }
  }

  /** A tab that was hidden for a while asks the server what happened meanwhile. */
  async onVisible(): Promise<void> {
    const { phase, activeId } = this.state;
    if (phase !== 'ready' || !activeId) return;
    if (this.now() - this.lastRefreshMs < (this.deps.refreshAfterMs ?? 10 * 60_000)) return;
    await this.perform(async () => {
      const tank = await this.deps.api.tank(activeId);
      this.lastRefreshMs = this.now();
      this.apply(tank);
      if (shouldShowAway(tank.away)) {
        this.patch({ awayByTank: { ...this.state.awayByTank, [tank.id]: tank.away } });
      }
    });
  }

  dismissAway(tankId: string): void {
    const rest = Object.entries(this.state.awayByTank).filter(([id]) => id !== tankId);
    this.patch({ awayByTank: Object.fromEntries(rest) });
  }

  clearMessages(): void {
    this.patch({ error: null, notice: null });
  }

  async select(tankId: string): Promise<void> {
    if (tankId === this.state.activeId || !this.state.tanks.some((t) => t.id === tankId)) return;
    await this.leaveActive();
    this.deps.storage?.setItem(ACTIVE_KEY, tankId);
    this.patch({ activeId: tankId });
    this.activate(tankId);
    await this.perform(async () => this.apply(await this.deps.api.tank(tankId)));
  }

  async createTank(name: string, biome: Biome): Promise<boolean> {
    const made: { tank?: Tank } = {};
    const ok = await this.perform(async () => {
      made.tank = await this.deps.api.createTank({ name, biome });
    });
    const tank = made.tank;
    if (!ok || !tank) return false;
    await this.leaveActive();
    this.patch({
      tanks: upsertTank(this.state.tanks, tank),
      activeId: tank.id,
      notice: `${tank.name} is ready.`,
    });
    this.deps.storage?.setItem(ACTIVE_KEY, tank.id);
    this.activate(tank.id);
    return true;
  }

  async rename(name: string): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    return this.perform(async () => {
      this.apply(await this.deps.api.renameTank(tank.id, name));
      this.patch({ notice: 'Tank renamed.' });
    });
  }

  async feed(food: FoodType, portion: number): Promise<boolean> {
    return this.careAction({ type: 'feed', food, portion });
  }

  async careAction(action: CareAction): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    return this.perform(async () => {
      this.apply(await this.deps.api.care(tank.id, action));
      this.deps.interaction.emit('tank:care', { tankId: tank.id, action: action.type });
      if (action.type !== 'feed') this.patch({ notice: CARE_DONE[action.type] });
    });
  }

  async buy(speciesId: string, name: string): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    return this.perform(async () => {
      const next = await this.deps.api.addFish(tank.id, { species: speciesId, name });
      this.apply(next, { acclimateNew: true });
      this.patch({ notice: `${name} is in a bag, getting used to the water.` });
    });
  }

  async net(fishId: string): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    return this.perform(async () => {
      const fish = tank.fish.find((f) => f.id === fishId);
      this.apply(await this.deps.api.netFish(tank.id, fishId), { removal: 'netted' });
      this.patch({ notice: fish ? `${fish.name} was netted and added to the memorial.` : null });
    });
  }

  /** Releases a bagged fish now instead of waiting out the acclimation. */
  releaseNow(fishId: string): void {
    this.release(fishId);
  }

  private async reset(phase: 'anonymous' | 'unverified'): Promise<void> {
    this.loadId++;
    await this.leaveActive();
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    this.state = { ...INITIAL, phase };
    this.emitChange();
  }

  private activate(tankId: string): void {
    const tank = this.state.tanks.find((t) => t.id === tankId);
    if (!tank) return;
    this.uploader = new AteUploader({
      ...this.deps.ateOptions,
      sleep: this.sleep,
      send: async (reports) => {
        this.apply(await this.enqueue(() => this.deps.api.reportAte(tankId, reports)));
      },
      onDropped: (reason, reports) => {
        if (reason === 'rejected') return;
        console.warn(`dropped ${reports.length} eating reports (${reason})`);
      },
    });
    this.deps.interaction.emit('tank:loaded', {
      tankId,
      biome: tank.biome,
      fish: tank.fish,
    });
    this.deps.interaction.emit('tank:water', { tankId, water: tank.water });
  }

  private async leaveActive(): Promise<void> {
    const tankId = this.state.activeId;
    const uploader = this.uploader;
    this.uploader = null;
    if (uploader) {
      await uploader.flushNow().catch(() => undefined);
      uploader.dispose();
    }
    for (const bag of this.state.bagged) this.cancelRelease(bag.fishId);
    this.patch({ bagged: [] });
    if (tankId) this.deps.interaction.emit('tank:unloaded', { tankId });
  }

  /** All requests run one after another so snapshots always arrive in the order the server made them. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async perform(task: () => Promise<void>): Promise<boolean> {
    this.inFlight++;
    this.patch({ busy: true, error: null });
    try {
      await this.enqueue(task);
      return true;
    } catch (error) {
      this.patch({ error: describeSyncError(error), notice: null });
      return false;
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) this.patch({ busy: false });
    }
  }

  private apply(
    tank: Tank,
    options: { acclimateNew?: boolean; removal?: 'netted' | 'gone' } = {},
  ): void {
    const held = this.state.tanks.find((t) => t.id === tank.id);
    if (isStaleSnapshot(held, tank)) return;
    this.patch({ tanks: upsertTank(this.state.tanks, tank) });
    if (tank.id !== this.state.activeId || !held) return;

    const { interaction } = this.deps;
    const diff = diffFish(held.fish, tank.fish);
    for (const fish of diff.removed) {
      this.cancelRelease(fish.id);
      interaction.emit('tank:fish-removed', {
        tankId: tank.id,
        fishId: fish.id,
        reason: options.removal ?? 'gone',
      });
    }
    for (const fish of diff.added) {
      const acclimate = options.acclimateNew === true && fish.status === 'alive';
      interaction.emit('tank:fish-added', { tankId: tank.id, fish, acclimate });
      if (acclimate) this.bag(tank.id, fish.id, fish.name);
    }
    for (const fish of diff.died) {
      this.cancelRelease(fish.id);
      interaction.emit('tank:fish-died', { tankId: tank.id, fish });
    }
    if (held.water !== tank.water)
      interaction.emit('tank:water', { tankId: tank.id, water: tank.water });
  }

  private bag(tankId: string, fishId: string, name: string): void {
    const releaseAtMs = this.now() + ACCLIMATION_SECONDS * 1_000;
    this.patch({ bagged: [...this.state.bagged, { fishId, name, releaseAtMs }] });
    this.releaseTimers.set(
      fishId,
      setTimeout(() => this.release(fishId, tankId), ACCLIMATION_SECONDS * 1_000),
    );
  }

  private release(fishId: string, tankId = this.state.activeId): void {
    if (!this.state.bagged.some((b) => b.fishId === fishId)) return;
    this.cancelRelease(fishId);
    if (tankId) this.deps.interaction.emit('tank:fish-released', { tankId, fishId });
  }

  private cancelRelease(fishId: string): void {
    const timer = this.releaseTimers.get(fishId);
    if (timer) clearTimeout(timer);
    this.releaseTimers.delete(fishId);
    this.patch({ bagged: this.state.bagged.filter((b) => b.fishId !== fishId) });
  }

  private patch(change: Partial<SessionState>): void {
    this.state = { ...this.state, ...change };
    this.emitChange();
  }

  private emitChange(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const CARE_DONE: Record<Exclude<CareAction['type'], 'feed'>, string> = {
  water_change: 'Half the water was changed.',
  gravel_vacuum: 'The gravel is clean.',
  algae_scrape: 'The glass is clear.',
};
