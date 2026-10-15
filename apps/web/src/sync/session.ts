import type {
  AwaySummary,
  Biome,
  CareAction,
  DecorLayout,
  FoodType,
  Tank,
  User,
} from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import { layoutKey } from '../interaction/decor/key';
import type { InteractionEvents } from '../interaction/events';
import type { ApiClient } from '../ui/api';
import { AteUploader, type AteUploaderOptions } from './ateUploader';
import { withRetry, realSleep, type Sleep } from './backoff';
import { LayoutSaver } from './layout';
import { ACCLIMATION_SECONDS, shouldShowAway } from './life';
import { describeSyncError } from './messages';
import { INITIAL_STATE, type SessionState } from './state';
import { diffFish, isStaleSnapshot, upsertTank } from './reconcile';

export type { BaggedFish, SessionPhase, SessionState } from './state';

export interface SessionDeps {
  api: ApiClient;
  interaction: EventBus<InteractionEvents>;
  now?: () => number;
  sleep?: Sleep;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  ateOptions?: Omit<AteUploaderOptions, 'send' | 'onDropped'>;
  /** Visible-again refreshes only run after this long, matching the server's 10 minute step. */
  refreshAfterMs?: number;
  /** Longest a tank switch waits for pending eating reports; the rest are dropped with a notice. */
  leaveFlushMs?: number;
  layoutDebounceMs?: number;
}

const ACTIVE_KEY = 'aquarium.activeTank';
const LOAD_ATTEMPTS = 4;
const LEAVE_FLUSH_MS = 3_000;

export class TankSession {
  private state: SessionState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private uploader: AteUploader | null = null;
  private lastRefreshMs = 0;
  private loadId = 0;
  private switchId = 0;
  private loadedId: string | null = null;
  private readonly shownLayout = new Map<string, string>();
  private readonly layoutSaver: LayoutSaver;
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stopListening: (() => void)[];
  private readonly now: () => number;
  private readonly sleep: Sleep;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? realSleep;
    this.layoutSaver = new LayoutSaver({
      sleep: this.sleep,
      debounceMs: deps.layoutDebounceMs,
      report: (status, message) => deps.interaction.emit('decor:save-state', { status, message }),
      send: async (tankId, layout) => {
        const gen = this.loadId;
        const next = await this.enqueue(() => deps.api.saveDecorLayout(tankId, layout));
        if (gen === this.loadId) this.apply(next);
      },
    });
    this.stopListening = [
      deps.interaction.on('decor:layout', ({ tankId, layout }) => {
        this.shownLayout.set(tankId, decorKey(true, layout));
        this.layoutSaver.submit(tankId, layout);
      }),
      deps.interaction.on('decor:command', (command) => {
        if (command.type === 'retry-save') this.layoutSaver.retry();
      }),
      deps.interaction.on('decor:mode-changed', ({ active }) => {
        if (!active) void this.layoutSaver.flush();
      }),
      deps.interaction.on('feed:dropped', ({ food, portion }) => void this.feed(food, portion)),
      deps.interaction.on('food:ate', ({ eaten }) => {
        for (const e of eaten) this.uploader?.add(e.fishId, e.portion);
      }),
      deps.interaction.on('net:tap', ({ fishId }) => this.requestNet(fishId)),
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
    this.layoutSaver.dispose();
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
    this.switchId++;
    this.unloadScene('switch')?.dispose();
    this.patch({
      phase: 'loading',
      tanks: [],
      activeId: null,
      awayByTank: {},
      pendingNet: null,
      error: null,
      notice: null,
    });
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
      else this.deps.interaction.emit('tank:none', {});
    } catch (error) {
      if (id !== this.loadId) return;
      this.patch({ phase: 'offline', error: describeSyncError(error) });
      this.deps.interaction.emit('tank:none', {});
    }
  }

  /** A tab that was hidden for a while asks the server what happened meanwhile. */
  async onVisible(): Promise<void> {
    const { phase, activeId } = this.state;
    if (phase !== 'ready' || !activeId) return;
    if (this.now() - this.lastRefreshMs < (this.deps.refreshAfterMs ?? 10 * 60_000)) return;
    const gen = this.loadId;
    await this.perform(async () => {
      const tank = await this.deps.api.tank(activeId);
      if (gen !== this.loadId) return;
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
    if (this.state.phase !== 'ready') return;
    if (tankId === this.state.activeId || !this.state.tanks.some((t) => t.id === tankId)) return;
    const id = ++this.switchId;
    this.deps.storage?.setItem(ACTIVE_KEY, tankId);
    this.patch({ activeId: tankId, pendingNet: null });
    await this.track(async () => {
      await this.leaveActive();
      if (id !== this.switchId) return;
      this.activate(tankId);
      const gen = this.loadId;
      await this.perform(async () => {
        const next = await this.deps.api.tank(tankId);
        if (gen === this.loadId) this.apply(next);
      });
    });
  }

  async createTank(name: string, biome: Biome): Promise<boolean> {
    if (this.state.phase !== 'ready') return false;
    const generation = this.loadId;
    const made: { tank?: Tank } = {};
    const ok = await this.perform(async () => {
      made.tank = await this.deps.api.createTank({ name, biome });
    });
    const tank = made.tank;
    if (!ok || !tank) return false;
    if (generation !== this.loadId || this.state.phase !== 'ready') return false;
    const id = ++this.switchId;
    this.deps.storage?.setItem(ACTIVE_KEY, tank.id);
    this.patch({
      tanks: upsertTank(this.state.tanks, tank),
      activeId: tank.id,
      pendingNet: null,
      notice: `${tank.name} is ready.`,
    });
    await this.track(async () => {
      await this.leaveActive();
      if (id === this.switchId) this.activate(tank.id);
    });
    return true;
  }

  async rename(name: string): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    return this.perform(async () => {
      const next = await this.deps.api.renameTank(tank.id, name);
      if (gen !== this.loadId) return;
      this.apply(next);
      this.patch({ notice: 'Tank renamed.' });
    });
  }

  async feed(food: FoodType, portion: number): Promise<boolean> {
    return this.careAction({ type: 'feed', food, portion });
  }

  async careAction(action: CareAction): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    return this.perform(async () => {
      const next = await this.deps.api.care(tank.id, action);
      if (gen !== this.loadId) return;
      this.apply(next);
      this.deps.interaction.emit('tank:care', { tankId: tank.id, action: action.type });
      if (action.type !== 'feed') this.patch({ notice: CARE_DONE[action.type] });
    });
  }

  async buy(speciesId: string, name: string): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    return this.perform(async () => {
      const next = await this.deps.api.addFish(tank.id, { species: speciesId, name });
      if (gen !== this.loadId) return;
      this.apply(next, { acclimateNew: true });
      this.patch({ notice: `${name} is in a bag, getting used to the water.` });
    });
  }

  /** Asks to net a dead fish; nothing happens to the tank until `confirmNet`. */
  requestNet(fishId: string): void {
    const fish = this.activeTank?.fish.find((f) => f.id === fishId);
    if (fish?.status !== 'dead') return;
    this.patch({ pendingNet: fishId });
  }

  cancelNet(): void {
    this.patch({ pendingNet: null });
  }

  async confirmNet(): Promise<boolean> {
    const fishId = this.state.pendingNet;
    if (!fishId) return false;
    this.patch({ pendingNet: null });
    return this.net(fishId);
  }

  async net(fishId: string): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    return this.perform(async () => {
      const fish = tank.fish.find((f) => f.id === fishId);
      const next = await this.deps.api.netFish(tank.id, fishId);
      if (gen !== this.loadId) return;
      this.apply(next, { removal: 'netted' });
      this.patch({ notice: fish ? `${fish.name} was netted and added to the memorial.` : null });
    });
  }

  /** Releases a bagged fish now instead of waiting out the acclimation. */
  releaseNow(fishId: string): void {
    this.release(fishId);
  }

  private async reset(phase: 'anonymous' | 'unverified'): Promise<void> {
    this.loadId++;
    this.switchId++;
    this.unloadScene('reset')?.dispose();
    this.layoutSaver.reset();
    this.shownLayout.clear();
    this.deps.storage?.removeItem(ACTIVE_KEY);
    this.deps.interaction.emit('tank:none', {});
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    this.state = { ...INITIAL_STATE, phase };
    this.emitChange();
  }

  private activate(tankId: string): void {
    const tank = this.state.tanks.find((t) => t.id === tankId);
    if (!tank) return;
    this.unloadScene('switch')?.dispose();
    const gen = this.loadId;
    this.loadedId = tankId;
    this.shownLayout.set(tankId, decorKey(tank.decorEdited, tank.decorLayout));
    this.uploader = new AteUploader({
      ...this.deps.ateOptions,
      sleep: this.sleep,
      send: async (reports, batchId) => {
        const next = await this.enqueue(() => this.deps.api.reportAte(tankId, reports, batchId));
        if (gen === this.loadId) this.apply(next);
      },
      onDropped: (reason, reports, cause) => {
        if (reason === 'rejected') return;
        console.warn(`dropped ${reports.length} eating reports (${reason})`, cause);
      },
    });
    this.deps.interaction.emit('tank:loaded', {
      tankId,
      biome: tank.biome,
      fish: tank.fish,
      decorLayout: tank.decorLayout,
      decorEdited: tank.decorEdited,
    });
    this.deps.interaction.emit('tank:water', { tankId, water: tank.water });
  }

  /** Unloads synchronously, so overlapping switches unload once; only the report flush is awaited. */
  private async leaveActive(): Promise<void> {
    const uploader = this.unloadScene('switch');
    if (!uploader) return;
    const gen = this.loadId;
    const finished = await this.flushBounded(uploader);
    uploader.dispose();
    if (!finished && gen === this.loadId) {
      this.patch({
        notice: 'Some feeding reports could not be sent and were dropped. The tank is unaffected.',
      });
    }
  }

  private unloadScene(reason: InteractionEvents['tank:unloaded']['reason']): AteUploader | null {
    const tankId = this.loadedId;
    const uploader = this.uploader;
    this.loadedId = null;
    this.uploader = null;
    for (const bag of this.state.bagged) this.cancelRelease(bag.fishId);
    this.patch({ bagged: [] });
    if (tankId) this.deps.interaction.emit('tank:unloaded', { tankId, reason });
    return uploader;
  }

  private async flushBounded(uploader: AteUploader): Promise<boolean> {
    if (uploader.settled) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.deps.leaveFlushMs ?? LEAVE_FLUSH_MS);
    });
    const flushed = uploader.flushNow().then(
      () => uploader.settled,
      () => false,
    );
    try {
      return await Promise.race([flushed, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async track(task: () => Promise<void>): Promise<void> {
    this.inFlight++;
    this.patch({ busy: true });
    try {
      await task();
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) this.patch({ busy: false });
    }
  }

  /** All requests run one after another so snapshots always arrive in the order the server made them. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async perform(task: () => Promise<void>): Promise<boolean> {
    const gen = this.loadId;
    this.inFlight++;
    this.patch({ busy: true, error: null });
    try {
      await this.enqueue(task);
      return true;
    } catch (error) {
      if (gen !== this.loadId) return false;
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
    if (this.state.phase !== 'ready') return;
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
      const species = this.state.species.find((sp) => sp.id === fish.species)?.commonName;
      this.patch({
        notice: `${fish.name} the ${species?.toLowerCase() ?? 'fish'} has died. You can net them when you are ready.`,
      });
    }
    const incomingLayout = decorKey(tank.decorEdited, tank.decorLayout);
    if (!this.layoutSaver.busy && incomingLayout !== this.shownLayout.get(tank.id)) {
      this.shownLayout.set(tank.id, incomingLayout);
      interaction.emit('tank:decor', {
        tankId: tank.id,
        layout: tank.decorLayout,
        edited: tank.decorEdited,
      });
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

function decorKey(edited: boolean, layout: DecorLayout): string {
  return `${edited ? 'edited' : 'preset'}:${layoutKey(layout)}`;
}

const CARE_DONE: Record<Exclude<CareAction['type'], 'feed'>, string> = {
  water_change: 'Half the water was changed.',
  gravel_vacuum: 'The gravel is clean.',
  algae_scrape: 'The glass is clear.',
};
