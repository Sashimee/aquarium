import type {
  AwaySummary,
  BackgroundId,
  CreatableBiome,
  CareAction,
  ConflictReason,
  DecorLayout,
  DiseaseKind,
  FoodType,
  LightSchedule,
  MedicinePotency,
  PurchasableStage,
  Tank,
  TankSize,
  User,
} from '@aquarium/shared';
import {
  DEFAULT_TANK_SIZE,
  isFreeRoom,
  ONE_TIME_REF,
  roomIdSchema,
  roomRef,
  type RoomId,
} from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import { layoutKey } from '../interaction/decor/key';
import type { InteractionEvents } from '../interaction/events';
import { ApiRequestError, type ApiClient } from '../ui/api';
import { AteUploader, type AteUploaderOptions } from './ateUploader';
import { withRetry, realSleep, type Sleep } from './backoff';
import { IntentKeys, outcomeUnknown } from './intentKeys';
import { LayoutSaver } from './layout';
import {
  ACCLIMATION_SECONDS,
  birthSentence,
  newborns,
  shouldShowAway,
  speciesNameMap,
} from './life';
import { DEVICE_ROOM_KEY, planRoomMigration } from './roomMigration';
import { SaveStatusMerge } from './saveStatus';
import { describeSyncError } from './messages';
import { moveRefusalText } from './moveFish';
import { INITIAL_STATE, type SessionState } from './state';
import { coralLabel, fragRefusalText, sameCorals } from './coralCare';
import { plantLabel, samePlants, trimRefusalText } from './plantTrim';
import { DISEASE_LABEL } from './treatment';
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
  /** Makes the idempotency key of a new purchase intent; tests inject a counter. */
  newKey?: () => string;
}

export interface TreatOutcome {
  ok: boolean;
  overdose: boolean;
  /** The server's reason when it refused the dose with a 409. */
  refusal: string | null;
  /** The server's machine-readable reason for the 409. */
  reason: ConflictReason | null;
}

export interface MoveOutcome {
  ok: boolean;
  refusal: string | null;
}

export interface TrimOutcome {
  ok: boolean;
  refusal: string | null;
}

export interface FragOutcome {
  ok: boolean;
  refusal: string | null;
}

export interface ShareOutcome {
  ok: boolean;
  token: string | null;
}

const ACTIVE_KEY = 'aquarium.activeTank';
const LOAD_ATTEMPTS = 4;
const LEAVE_FLUSH_MS = 3_000;
const TRIM_KEY_TTL_MS = 10 * 60_000;

export class TankSession {
  private state: SessionState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private uploader: AteUploader | null = null;
  private lastRefreshMs = 0;
  private walletSeq = 0;
  private walletApplied = 0;
  private walletRead: { load: number; promise: Promise<void> } | null = null;
  private loadId = 0;
  private queueEpoch = 0;
  private switchId = 0;
  private loadedId: string | null = null;
  private readonly shownLayout = new Map<string, string>();
  private readonly shownBackground = new Map<string, BackgroundId>();
  private readonly layoutSaver: LayoutSaver<DecorLayout>;
  private readonly backgroundSaver: LayoutSaver<BackgroundId>;
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stopListening: (() => void)[];
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly keys: IntentKeys;
  private readonly trimKeys: IntentKeys;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? realSleep;
    this.keys = new IntentKeys(deps.newKey);
    this.trimKeys = new IntentKeys(deps.newKey, TRIM_KEY_TTL_MS, this.now);
    const saveStatus = new SaveStatusMerge((status, message, source, reported) =>
      deps.interaction.emit('decor:save-state', { status, message, source, reported }),
    );
    this.layoutSaver = new LayoutSaver({
      sleep: this.sleep,
      debounceMs: deps.layoutDebounceMs,
      report: saveStatus.reporter('layout'),
      send: async (tankId, layout) => {
        const gen = this.loadId;
        const next = await this.enqueue(() => deps.api.saveDecorLayout(tankId, layout));
        if (gen === this.loadId) this.apply(next);
      },
    });
    this.backgroundSaver = new LayoutSaver({
      sleep: this.sleep,
      debounceMs: deps.layoutDebounceMs,
      report: saveStatus.reporter('background'),
      send: async (tankId, backgroundId) => {
        const gen = this.loadId;
        const next = await this.enqueue(() => deps.api.saveBackground(tankId, backgroundId));
        if (gen === this.loadId) this.apply(next);
      },
    });
    this.stopListening = [
      deps.interaction.on('background:save', ({ tankId, backgroundId }) => {
        this.shownBackground.set(tankId, backgroundId);
        this.backgroundSaver.submit(tankId, backgroundId);
      }),
      deps.interaction.on('decor:layout', ({ tankId, layout }) => {
        this.shownLayout.set(tankId, decorKey(true, layout));
        this.layoutSaver.submit(tankId, layout);
      }),
      deps.interaction.on('decor:command', (command) => {
        if (command.type !== 'retry-save') return;
        this.layoutSaver.retry();
        this.backgroundSaver.retry();
      }),
      deps.interaction.on('decor:mode-changed', ({ active }) => {
        if (active) return;
        void this.layoutSaver.flush();
        void this.backgroundSaver.flush();
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
    this.backgroundSaver.dispose();
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
    this.roomsKnown = false;
    this.switchId++;
    this.unloadScene('switch')?.dispose();
    this.patch({
      phase: 'loading',
      tanks: [],
      activeId: null,
      awayByTank: {},
      owned: [],
      ownedRooms: [],
      pendingNet: null,
      error: null,
      notice: null,
      birth: null,
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
      void this.refreshWallet();
      void this.refreshRooms();
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
    await this.refreshWallet();
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

  dismissBirth(): void {
    if (this.state.birth) this.patch({ birth: null });
  }

  focusBrood(): void {
    const { birth } = this.state;
    if (!birth) return;
    this.deps.interaction.emit('camera:focus-fish', { fishIds: birth.fishIds });
    this.patch({ birth: null });
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
      if (!this.activate(tankId)) return;
      const gen = this.loadId;
      await this.perform(async () => {
        const next = await this.deps.api.tank(tankId);
        if (gen === this.loadId) this.apply(next);
      });
    });
  }

  /**
   * The balance the server reports. A failed read keeps the last one shown rather than hiding it.
   * Reads started while another is in flight share it; a read after a write never does, and a read
   * that lands after a newer one, or after a purchase reply, is dropped.
   */
  refreshWallet(options: { afterWrite?: boolean } = {}): Promise<void> {
    const joined = this.walletRead;
    if (!options.afterWrite && joined?.load === this.loadId) return joined.promise;
    const entry = {
      load: this.loadId,
      promise: this.readWallet().finally(() => {
        if (this.walletRead === entry) this.walletRead = null;
      }),
    };
    this.walletRead = entry;
    return entry.promise;
  }

  private async readWallet(): Promise<void> {
    const gen = this.loadId;
    const seq = ++this.walletSeq;
    try {
      const wallet = await this.deps.api.wallet();
      if (gen !== this.loadId || seq < this.walletApplied) return;
      this.walletApplied = seq;
      const before = this.state.balance;
      const gained = before !== null && wallet.balance > before ? wallet.balance - before : 0;
      this.patch({
        balance: wallet.balance,
        owned: [...wallet.owned],
        ...(gained > 0 ? { earned: (this.state.earned ?? 0) + gained } : {}),
      });
    } catch (error) {
      if (!(error instanceof ApiRequestError)) throw error;
    }
  }

  /**
   * An empty list means "owns nothing" only once a read has succeeded, so the device-room migration
   * waits for that and a failed read never loses it.
   */
  private roomsKnown = false;
  private roomMigration: Promise<void> = Promise.resolve();

  /** The paid rooms the account owns. A failed read keeps the last list; the server checks every use. */
  async refreshRooms(): Promise<void> {
    const gen = this.loadId;
    try {
      const owned = await this.deps.api.ownedRooms();
      if (gen !== this.loadId) return;
      this.roomsKnown = true;
      this.patch({ ownedRooms: owned });
      await this.migrateDeviceRoom(gen);
    } catch (error) {
      if (!(error instanceof ApiRequestError)) throw error;
    }
  }

  private readonly buyingRooms = new Set<RoomId>();

  /**
   * Buys a paid room for the whole account. A room that is free or already owned is never charged,
   * and a second press while the first is out is dropped; a retry after an unknown outcome carries
   * the same key, so the server replays instead of charging twice.
   */
  async buyRoom(roomId: RoomId): Promise<boolean> {
    if (isFreeRoom(roomId) || this.state.ownedRooms.includes(roomId)) return true;
    if (this.buyingRooms.has(roomId)) return false;
    this.buyingRooms.add(roomId);
    const itemRef = roomRef(roomId);
    const gen = this.loadId;
    try {
      return await this.paid(`buy:${itemRef}`, async (idempotencyKey) => {
        let bought;
        try {
          bought = await this.deps.api.purchase({ itemRef, idempotencyKey });
        } catch (error) {
          if (error instanceof ApiRequestError && error.reason === 'room_already_owned') {
            this.patch({ ownedRooms: [...new Set([...this.state.ownedRooms, roomId])] });
          }
          throw error;
        }
        if (gen !== this.loadId) return;
        this.walletApplied = ++this.walletSeq;
        this.patch({
          balance: bought.wallet.balance,
          ownedRooms: [...new Set([...this.state.ownedRooms, roomId])],
        });
      });
    } finally {
      this.buyingRooms.delete(roomId);
    }
  }

  /** Sets the active tank's room; null is the plain studio. A paid room has to be bought first. */
  async setRoom(roomId: RoomId | null): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    if (roomId !== null && !roomIdSchema.safeParse(roomId).success) {
      this.patch({ error: 'That room does not exist.' });
      return false;
    }
    if (roomId !== null && !isFreeRoom(roomId) && !this.state.ownedRooms.includes(roomId)) {
      this.patch({ error: 'That room is not unlocked yet. Buy it first.' });
      return false;
    }
    if (roomId === tank.roomId) return true;
    const gen = this.loadId;
    return this.perform(async () => {
      try {
        const next = await this.deps.api.saveRoom(tank.id, roomId);
        if (gen === this.loadId) this.apply(next);
      } catch (error) {
        if (error instanceof ApiRequestError && error.reason === 'room_not_owned') {
          void this.refreshRooms();
        }
        throw error;
      }
    });
  }

  /** Runs after any earlier migration has stopped, so a reload never has two writing at once. */
  private migrateDeviceRoom(loadId: number): Promise<void> {
    const run = this.roomMigration.then(() => this.runRoomMigration(loadId));
    this.roomMigration = run.catch(() => undefined);
    return run;
  }

  private async runRoomMigration(loadId: number): Promise<void> {
    const storage = this.deps.storage;
    if (!storage || !this.roomsKnown) return;
    if (loadId !== this.loadId || this.state.phase !== 'ready') return;
    const plan = planRoomMigration(
      storage.getItem(DEVICE_ROOM_KEY),
      this.state.tanks,
      this.state.ownedRooms,
    );
    for (const move of plan.moves) {
      if (loadId !== this.loadId) return;
      const moved = await this.perform(async () => {
        if (loadId !== this.loadId) return;
        const current = this.state.tanks.find((t) => t.id === move.tankId);
        if (!current || current.roomSetAt !== null) return;
        const next = await this.deps.api.saveRoom(move.tankId, move.roomId);
        if (loadId === this.loadId) this.apply(next);
      });
      if (!moved) return;
    }
    if (plan.done && loadId === this.loadId) storage.removeItem(DEVICE_ROOM_KEY);
  }

  dismissEarned(): void {
    if (this.state.earned !== null) this.patch({ earned: null });
  }

  /**
   * Runs one paid request under the key of its intent. Where the outcome is unknown the key stays,
   * so pressing the button again is a retry that cannot charge twice.
   */
  private async paid(intent: string, call: (key: string) => Promise<void>): Promise<boolean> {
    const key = this.keys.keyFor(intent);
    if (this.state.pearlsRefused) this.patch({ pearlsRefused: false });
    let refused = false;
    const ok = await this.perform(async () => {
      try {
        await call(key);
      } catch (error) {
        if (!outcomeUnknown(error)) this.keys.settle(intent);
        refused = error instanceof ApiRequestError && error.code === 'insufficient_pearls';
        throw error;
      }
      this.keys.settle(intent);
    });
    await this.refreshWallet({ afterWrite: true });
    if (refused) this.patch({ pearlsRefused: true });
    return ok;
  }

  async createTank(
    name: string,
    biome: CreatableBiome,
    size: TankSize = DEFAULT_TANK_SIZE,
    quarantine = false,
  ): Promise<boolean> {
    if (this.state.phase !== 'ready') return false;
    const generation = this.loadId;
    const made: { tank?: Tank } = {};
    const intent = `tank:${biome}:${size}:${quarantine ? 'q:' : ''}${name}`;
    const ok = await this.paid(intent, async (idempotencyKey) => {
      made.tank = await this.deps.api.createTank({
        name,
        biome,
        size,
        ...(quarantine ? { quarantine } : {}),
        idempotencyKey,
      });
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

  /**
   * The share token is in the response of share and rotate only. It goes to the caller and is
   * stripped from the stored tank, so it never lingers in session state.
   */
  async changeSharing(change: 'share' | 'rotate' | 'revoke'): Promise<ShareOutcome> {
    const tank = this.activeTank;
    if (!tank) return { ok: false, token: null };
    const gen = this.loadId;
    let token: string | null = null;
    const ok = await this.perform(async () => {
      const { api } = this.deps;
      const next = await (change === 'share'
        ? api.shareTank(tank.id)
        : change === 'rotate'
          ? api.rotateShare(tank.id)
          : api.revokeShare(tank.id));
      token = next.shareToken;
      if (gen !== this.loadId) return;
      this.apply({ ...next, shareToken: null });
    });
    return { ok, token };
  }

  async setGalleryListed(listed: boolean): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    return this.perform(async () => {
      const next = await this.deps.api.setGallery(tank.id, listed);
      if (gen !== this.loadId) return;
      this.apply({ ...next, shareToken: null });
      this.patch({
        notice: listed ? 'Your tank is in the gallery.' : 'Your tank is out of the gallery.',
      });
    });
  }

  async feed(food: FoodType, portion: number): Promise<boolean> {
    return this.careAction({ type: 'feed', food, portion });
  }

  async careAction(action: CareRequest): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    const run = async (sent: CareAction) => {
      const next = await this.deps.api.care(tank.id, sent);
      if (gen !== this.loadId) return;
      this.apply(next);
      this.deps.interaction.emit('tank:care', { tankId: tank.id, action: sent.type });
      if (sent.type !== 'feed') this.patch({ notice: CARE_DONE[sent.type] });
    };
    switch (action.type) {
      case 'bottled_bacteria':
        return this.paid(`bacteria:${tank.id}`, (idempotencyKey) =>
          run({ type: 'bottled_bacteria', idempotencyKey }),
        );
      case 'buffer_dose':
        return this.paid(`buffer:${tank.id}`, (idempotencyKey) =>
          run({ type: 'buffer_dose', idempotencyKey }),
        );
      case 'add_botanicals':
        return this.paid(`botanicals:${tank.id}`, (idempotencyKey) =>
          run({ type: 'add_botanicals', idempotencyKey }),
        );
      default: {
        const ok = await this.perform(() => run(action));
        await this.refreshWallet({ afterWrite: true });
        return ok;
      }
    }
  }

  /** Doses the active tank. The key is kept across an unknown outcome, so a retry is never charged twice. */
  async treat(kind: DiseaseKind, potency: MedicinePotency): Promise<TreatOutcome> {
    const tank = this.activeTank;
    const outcome: TreatOutcome = { ok: false, overdose: false, refusal: null, reason: null };
    if (!tank) return outcome;
    const gen = this.loadId;
    outcome.ok = await this.paid(`treat:${tank.id}:${kind}:${potency}`, async (idempotencyKey) => {
      let result;
      try {
        result = await this.deps.api.treat(tank.id, { kind, potency, idempotencyKey });
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === 'conflict') {
          outcome.refusal = error.message;
          outcome.reason = error.reason;
          return;
        }
        throw error;
      }
      if (gen !== this.loadId) return;
      outcome.overdose = result.overdose;
      if (result.wallet) {
        this.walletApplied = ++this.walletSeq;
        this.patch({ balance: result.wallet.balance });
      }
      this.apply(result.tank);
      this.patch({
        notice: result.overdose
          ? 'The medicine is in, but the water now holds more than one dose. It poisons your fish until you change the water.'
          : `The ${DISEASE_LABEL[kind].toLowerCase()} medicine is in the water.`,
      });
    });
    if (outcome.refusal !== null) outcome.ok = false;
    return outcome;
  }

  /**
   * Cuts one plant of the active tank back to `size`. The key is kept across an unknown outcome, so
   * pressing again is a retry the server replays instead of trimming twice.
   */
  async trimPlant(plantKey: string, size: number): Promise<TrimOutcome> {
    const tank = this.activeTank;
    const outcome: TrimOutcome = { ok: false, refusal: null };
    const plant = tank?.plants?.find((p) => p.key === plantKey);
    if (!tank || !plant) return outcome;
    const label = plantLabel(plant.assetId);
    const gen = this.loadId;
    const intent = `trim:${tank.id}:${plantKey}:${size}`;
    const key = this.trimKeys.keyFor(intent);
    outcome.ok = await this.perform(async () => {
      let next;
      try {
        next = await this.deps.api.trimPlant(tank.id, {
          plantKey,
          size,
          idempotencyKey: key,
        });
      } catch (error) {
        const refusal = trimRefusalText(error, label);
        if (!outcomeUnknown(error)) this.trimKeys.settle(intent);
        if (refusal === null) throw error;
        outcome.refusal = refusal;
        if (error instanceof ApiRequestError && error.reason === 'plant_not_grown') {
          await this.resyncTank(tank.id, gen);
        }
        return;
      }
      this.trimKeys.settle(intent);
      if (gen !== this.loadId) return;
      this.apply(next);
      this.patch({ notice: `The ${label} was trimmed.` });
    });
    if (outcome.refusal !== null) outcome.ok = false;
    return outcome;
  }

  /**
   * Cuts a fragment off one coral of the active tank. The key is kept across an unknown outcome, so
   * pressing again is a retry the server replays instead of cutting twice.
   */
  async fragCoral(coralKey: string): Promise<FragOutcome> {
    const tank = this.activeTank;
    const outcome: FragOutcome = { ok: false, refusal: null };
    const coral = tank?.corals?.find((c) => c.key === coralKey);
    if (!tank || !coral) return outcome;
    const label = coralLabel(coral.assetId);
    const gen = this.loadId;
    const intent = `frag:${tank.id}:${coralKey}`;
    const key = this.trimKeys.keyFor(intent);
    outcome.ok = await this.perform(async () => {
      let next;
      try {
        next = await this.deps.api.fragCoral(tank.id, { coralKey, idempotencyKey: key });
      } catch (error) {
        const refusal = fragRefusalText(error, label);
        if (!outcomeUnknown(error)) this.trimKeys.settle(intent);
        if (refusal === null) throw error;
        outcome.refusal = refusal;
        if (error instanceof ApiRequestError && (error.status === 409 || error.status === 404)) {
          await this.resyncTank(tank.id, gen);
        }
        return;
      }
      this.trimKeys.settle(intent);
      if (gen !== this.loadId) return;
      this.apply(next);
      this.patch({ notice: `A fragment was cut from the ${label}.` });
    });
    if (outcome.refusal !== null) outcome.ok = false;
    return outcome;
  }

  /** Moves a fish out of the active tank. A refusal is handed back as text for the player. */
  async move(fishId: string, toTankId: string): Promise<MoveOutcome> {
    const tank = this.activeTank;
    const outcome: MoveOutcome = { ok: false, refusal: null };
    const fish = tank?.fish.find((f) => f.id === fishId);
    const target = this.state.tanks.find((t) => t.id === toTankId);
    if (!tank || !fish || !target) return outcome;
    const gen = this.loadId;
    const intent = `move:${tank.id}:${fishId}:${toTankId}`;
    const key = this.keys.keyFor(intent);
    outcome.ok = await this.perform(async () => {
      let result;
      try {
        result = await this.deps.api.moveFish(tank.id, fishId, {
          toTankId,
          idempotencyKey: key,
        });
      } catch (error) {
        const refusal = moveRefusalText(error, fish.name, target.name);
        if (refusal === null) {
          if (!outcomeUnknown(error)) this.keys.settle(intent);
          throw error;
        }
        outcome.refusal = refusal;
        if (!outcomeUnknown(error)) this.keys.settle(intent);
        return;
      }
      this.keys.settle(intent);
      this.keys.settle(`move:${toTankId}:${fishId}:${tank.id}`);
      if (gen !== this.loadId) return;
      this.apply(result.source);
      this.apply(result.destination);
      this.patch({ notice: `${fish.name} was moved to ${target.name}.` });
    });
    if (outcome.refusal !== null) outcome.ok = false;
    return outcome;
  }

  async buy(speciesId: string, name: string, stage: PurchasableStage): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    return this.paid(`fish:${tank.id}:${speciesId}:${stage}:${name}`, async (idempotencyKey) => {
      const next = await this.deps.api.addFish(tank.id, {
        species: speciesId,
        name,
        stage,
        idempotencyKey,
      });
      if (gen !== this.loadId) return;
      this.apply(next, { acclimateNew: true });
      this.patch({ notice: `${name} is in a bag, getting used to the water.` });
    });
  }

  /** Equipment, plants, decor and backgrounds: priced and charged by the server from its own list. */
  async purchase(itemRef: string, doneNotice: string): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    return this.paid(`buy:${tank.id}:${itemRef}`, async (idempotencyKey) => {
      let bought;
      try {
        bought = await this.deps.api.purchase({ itemRef, idempotencyKey, tankId: tank.id });
      } catch (error) {
        if (
          error instanceof ApiRequestError &&
          error.code === 'conflict' &&
          ONE_TIME_REF.test(itemRef)
        ) {
          this.patch({ owned: [...new Set([...this.state.owned, itemRef])] });
        }
        throw error;
      }
      if (gen !== this.loadId) return;
      this.walletApplied = ++this.walletSeq;
      this.patch({
        balance: bought.wallet.balance,
        ...(ONE_TIME_REF.test(itemRef)
          ? { owned: [...new Set([...this.state.owned, itemRef])] }
          : {}),
      });
      const next = await this.deps.api.tank(tank.id);
      if (gen !== this.loadId) return;
      this.apply(next);
      this.patch({ notice: doneNotice });
    });
  }

  async setLight(light: LightSchedule): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    return this.perform(async () => {
      const next = await this.deps.api.saveLight(tank.id, light);
      if (gen !== this.loadId) return;
      this.apply(next);
      this.patch({ notice: 'The lamp schedule is saved.' });
    });
  }

  async setCo2(tier: number): Promise<boolean> {
    const tank = this.activeTank;
    if (!tank) return false;
    const gen = this.loadId;
    return this.perform(async () => {
      const next = await this.deps.api.setCo2(tank.id, tier);
      if (gen !== this.loadId) return;
      this.apply(next);
      this.patch({ notice: tier === 0 ? 'The CO₂ is off.' : `The CO₂ runs at tier ${tier}.` });
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
    const ok = await this.perform(async () => {
      const fish = tank.fish.find((f) => f.id === fishId);
      const next = await this.deps.api.netFish(tank.id, fishId);
      if (gen !== this.loadId) return;
      this.apply(next, { removal: 'netted' });
      this.patch({ notice: fish ? `${fish.name} was netted and added to the memorial.` : null });
    });
    await this.refreshWallet({ afterWrite: true });
    return ok;
  }

  async setAcceptsGifts(tankId: string, acceptsGifts: boolean): Promise<boolean> {
    const gen = this.loadId;
    return this.perform(async () => {
      const next = await this.deps.api.setAcceptsGifts(tankId, acceptsGifts);
      if (gen !== this.loadId) return;
      this.apply(next);
      this.patch({
        notice: acceptsGifts
          ? `${next.name} now accepts gifted and traded fish.`
          : `${next.name} no longer accepts gifted fish.`,
      });
    });
  }

  /** A tank the gift calls changed; an arriving fish goes through the acclimation bag. */
  applyGiftTank(tank: Tank, arrived: boolean): void {
    this.apply(tank, { acclimateNew: arrived });
  }

  /** Releases a bagged fish now instead of waiting out the acclimation. */
  releaseNow(fishId: string): void {
    this.release(fishId);
  }

  private async resyncTank(tankId: string, gen: number): Promise<void> {
    try {
      const next = await this.deps.api.tank(tankId);
      if (gen === this.loadId) this.apply(next);
    } catch (error) {
      console.warn(
        'could not refresh the tank after a refused trim or cut; the next sync will',
        error,
      );
    }
  }

  private async reset(phase: 'anonymous' | 'unverified'): Promise<void> {
    this.loadId++;
    this.switchId++;
    this.queueEpoch++;
    this.unloadScene('reset')?.dispose();
    this.layoutSaver.reset();
    this.backgroundSaver.reset();
    this.keys.clear();
    this.trimKeys.clear();
    this.shownLayout.clear();
    this.shownBackground.clear();
    this.deps.storage?.removeItem(ACTIVE_KEY);
    this.deps.interaction.emit('tank:none', {});
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    this.state = { ...INITIAL_STATE, phase };
    this.emitChange();
  }

  /** False when the tank has gone; the first remaining tank is shown instead, else the demo. */
  private activate(tankId: string): boolean {
    const tank = this.state.tanks.find((t) => t.id === tankId);
    if (!tank) {
      this.showInstead('That tank is no longer available.');
      return false;
    }
    this.unloadScene('switch')?.dispose();
    const gen = this.loadId;
    this.loadedId = tankId;
    this.shownLayout.set(tankId, decorKey(tank.decorEdited, tank.decorLayout));
    this.shownBackground.set(tankId, tank.backgroundId);
    this.uploader = new AteUploader({
      ...this.deps.ateOptions,
      sleep: this.sleep,
      send: async (reports, batchId) => {
        const next = await this.enqueue(() => this.deps.api.reportAte(tankId, reports, batchId));
        if (gen === this.loadId) this.apply(next);
      },
      onDropped: (reason, reports, cause) => {
        if (reason === 'rejected') return;
        const message = `dropped ${reports.length} eating reports (${reason})`;
        if (cause === undefined) console.warn(message);
        else console.warn(message, cause);
      },
    });
    this.deps.interaction.emit('tank:loaded', {
      tankId,
      biome: tank.biome,
      size: tank.size,
      fish: tank.fish,
      decorLayout: tank.decorLayout,
      decorEdited: tank.decorEdited,
      backgroundId: tank.backgroundId,
      roomId: tank.roomId,
      recentVisitDays: tank.recentVisitDays,
    });
    this.deps.interaction.emit('tank:water', { tankId, water: tank.water });
    this.deps.interaction.emit('tank:plants', { tankId, plants: tank.plants ?? [] });
    this.deps.interaction.emit('tank:corals', { tankId, corals: tank.corals ?? [] });
    this.deps.interaction.emit('tank:wave-maker', {
      tankId,
      tier: tank.equipment.waveMaker.tier,
    });
    this.emitLamp(tank);
    return true;
  }

  private showInstead(gone: string): void {
    const next = this.state.tanks[0];
    if (!next) {
      this.deps.storage?.removeItem(ACTIVE_KEY);
      this.patch({ activeId: null, notice: `${gone} You have no tanks left.` });
      this.deps.interaction.emit('tank:none', {});
      return;
    }
    this.deps.storage?.setItem(ACTIVE_KEY, next.id);
    this.patch({ activeId: next.id, notice: `${gone} Showing ${next.name} instead.` });
    this.activate(next.id);
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
    this.patch({ bagged: [], birth: null });
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
    const epoch = this.queueEpoch;
    const guarded = () => {
      if (epoch !== this.queueEpoch) throw new SessionEnded();
      return task();
    };
    const run = this.chain.then(guarded, guarded);
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
    const brood = newborns(diff.added, options.acclimateNew === true);
    if (brood.length > 0) {
      this.patch({
        birth: {
          tankId: tank.id,
          fishIds: brood.map((f) => f.id),
          text: birthSentence(brood, speciesNameMap(this.state.species)),
        },
      });
    }
    for (const fish of diff.died) {
      this.cancelRelease(fish.id);
      interaction.emit('tank:fish-died', { tankId: tank.id, fish });
      const species = this.state.species.find((sp) => sp.id === fish.species)?.commonName;
      this.patch({
        notice: `${fish.name} the ${species?.toLowerCase() ?? 'fish'} has died. You can net them when you are ready.`,
      });
    }
    if (diff.updated.length > 0) {
      interaction.emit('tank:fish-updated', { tankId: tank.id, fish: diff.updated });
    }
    const incomingLayout = decorKey(tank.decorEdited, tank.decorLayout);
    if (!this.layoutSaver.busyFor(tank.id) && incomingLayout !== this.shownLayout.get(tank.id)) {
      this.shownLayout.set(tank.id, incomingLayout);
      interaction.emit('tank:decor', {
        tankId: tank.id,
        layout: tank.decorLayout,
        edited: tank.decorEdited,
      });
    }
    if (
      !this.backgroundSaver.busyFor(tank.id) &&
      tank.backgroundId !== this.shownBackground.get(tank.id)
    ) {
      this.shownBackground.set(tank.id, tank.backgroundId);
      interaction.emit('tank:background', { tankId: tank.id, backgroundId: tank.backgroundId });
    }
    if (held.roomId !== tank.roomId) {
      interaction.emit('tank:room', { tankId: tank.id, roomId: tank.roomId });
    }
    if (held.water !== tank.water)
      interaction.emit('tank:water', { tankId: tank.id, water: tank.water });
    if (!samePlants(held.plants, tank.plants)) {
      interaction.emit('tank:plants', { tankId: tank.id, plants: tank.plants ?? [] });
    }
    if (!sameCorals(held.corals, tank.corals)) {
      interaction.emit('tank:corals', { tankId: tank.id, corals: tank.corals ?? [] });
    }
    if (held.equipment.waveMaker.tier !== tank.equipment.waveMaker.tier) {
      interaction.emit('tank:wave-maker', {
        tankId: tank.id,
        tier: tank.equipment.waveMaker.tier,
      });
    }
    const lamp = held.equipment.light;
    if (
      lamp.intensity !== tank.equipment.light.intensity ||
      lamp.onHour !== tank.equipment.light.onHour ||
      lamp.offHour !== tank.equipment.light.offHour
    )
      this.emitLamp(tank);
  }

  private emitLamp(tank: Tank): void {
    const { intensity, onHour, offHour } = tank.equipment.light;
    this.deps.interaction.emit('tank:lamp', { tankId: tank.id, intensity, onHour, offHour });
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

/** A queued request that was dropped at sign-out, so it never reaches the next user's session. */
class SessionEnded extends Error {}

function decorKey(edited: boolean, layout: DecorLayout): string {
  return `${edited ? 'edited' : 'preset'}:${layoutKey(layout)}`;
}

export type PaidCareType = 'bottled_bacteria' | 'buffer_dose' | 'add_botanicals';

/** A care action as the UI asks for it: the session adds the Pearls request key to the paid ones. */
export type CareRequest = Exclude<CareAction, { type: PaidCareType }> | { type: PaidCareType };

const CARE_DONE: Record<Exclude<CareAction['type'], 'feed'>, string> = {
  water_change: 'Half the water was changed.',
  gravel_vacuum: 'The gravel is clean.',
  algae_scrape: 'The glass is clear.',
  bottled_bacteria: 'Beneficial bacteria were added to the filter.',
  filter_rinse: 'The filter was rinsed. Its bacteria took a hit.',
  salt_dose: 'Salt mix was dissolved into the water.',
  buffer_dose: 'Buffer was dissolved into the water.',
  add_botanicals: 'Botanicals were added to the water.',
};
