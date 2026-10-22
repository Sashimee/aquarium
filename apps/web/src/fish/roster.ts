import {
  personalitySchema,
  type Biome,
  type DiseaseState,
  type Fish,
  type FishSex,
  type FishStage,
  type Personality,
} from '@aquarium/shared';
import type { AteEvent, FishSpawn } from '@aquarium/sim';
import { HUNGER_PER_PORTION } from '@aquarium/sim/lifecycle';
import type { InteractionEvents } from '../interaction/events';

/** `swimming` fish are in the sim; bagged and dead ones are posed by the renderer alone. */
export type FishPhase = 'swimming' | 'bagged' | 'dead';

export interface RosterFish {
  /** Unique for the roster's lifetime, so a stale sim world can never be mistaken for this one. */
  readonly simId: string;
  /** The server's `Fish.id`; null for demo fish. */
  readonly serverId: string | null;
  /** Stable across reloads: the server id, or the demo spawn id. Seeds the fish's look. */
  readonly key: string;
  readonly species: string;
  /** As stored by the server; null for demo fish, whose sex comes from their key. */
  readonly sex: FishSex | null;
  /** Undefined means a length for its stage, up to the species' adult length. */
  readonly lengthM: number | undefined;
  /** As of the last server snapshot that carried this fish; null for demo fish, which are grown. */
  stage: FishStage | null;
  /** Epoch milliseconds; NaN for demo fish and for a birth time that does not parse. */
  bornAtMs: number;
  phase: FishPhase;
  /** 0 dead .. 1 healthy, as of the last server snapshot that carried this fish. */
  health: number;
  /** As of the last server snapshot that carried this fish; demo fish are never ill. */
  disease: DiseaseState | null;
  /** Fixed per fish by the server; undefined for demo fish and for a record that carries none. */
  readonly personality?: Personality;
  /**
   * The server's hunger as of the last snapshot that carried this fish, less what the server takes
   * off for each bite passed on since; unset for demo fish. A world rebuilt mid-session seeds the
   * gut from it. The server rejects a whole batch of bite reports it finds implausible, so after a
   * rejected batch this sits below the server's value until the next snapshot resets it.
   */
  hunger?: number;
}

/**
 * Which fish the tank shows: the demo stock, or the saved tank's fish from the `tank:*` events.
 * `revision` changes exactly when the swimming set does, i.e. when the sim needs a new world.
 */
export class TankRoster {
  private readonly fish = new Map<string, RosterFish>();
  private readonly simIdByServer = new Map<string, string>();
  private loaded: {
    readonly tankId: string;
    readonly biome: Biome;
    readonly recentVisitDays: number | null;
    visitHandedOut: boolean;
  } | null = null;
  /** Between a switch's unload and the session's `tank:loaded` or `tank:none`: show nothing. */
  private switching = false;
  private nextId = 0;
  private species: { readonly revision: number; readonly list: readonly string[] } | null = null;
  revision = 0;

  constructor(private demo: readonly FishSpawn[]) {
    this.showDemo();
  }

  get tankId(): string | null {
    return this.loaded?.tankId ?? null;
  }

  get biome(): Biome | null {
    return this.loaded?.biome ?? null;
  }

  /** How many of the last days the owner opened the loaded tank; null when it is not known. */
  get recentVisitDays(): number | null {
    return this.loaded?.recentVisitDays ?? null;
  }

  /**
   * The visit days, once per `tank:loaded`: a world rebuilt for the same visit (a resize, a
   * replaced worker, the first fish added) gets null, or the fish would greet the owner again.
   */
  takeVisitDays(): number | null {
    if (this.loaded === null || this.loaded.visitHandedOut) return null;
    this.loaded.visitHandedOut = true;
    return this.loaded.recentVisitDays;
  }

  get size(): number {
    return this.fish.size;
  }

  entries(): IterableIterator<RosterFish> {
    return this.fish.values();
  }

  get(simId: string): RosterFish | undefined {
    return this.fish.get(simId);
  }

  swimming(): RosterFish[] {
    return [...this.fish.values()].filter((f) => f.phase === 'swimming');
  }

  /** The distinct species in the sim, sorted; the same array until `revision` changes. */
  swimmingSpecies(): readonly string[] {
    if (this.species?.revision !== this.revision) {
      const list = [...new Set(this.swimming().map((f) => f.species))].sort();
      this.species = { revision: this.revision, list };
    }
    return this.species.list;
  }

  simIdOf(serverId: string): string | undefined {
    return this.simIdByServer.get(serverId);
  }

  serverIdOf(simId: string): string | undefined {
    return this.fish.get(simId)?.serverId ?? undefined;
  }

  load({ tankId, biome, fish, recentVisitDays }: InteractionEvents['tank:loaded']): void {
    this.clear();
    this.loaded = {
      tankId,
      biome,
      recentVisitDays: recentVisitDays ?? null,
      visitHandedOut: false,
    };
    this.switching = false;
    for (const f of fish) this.insertSaved(f, f.status === 'dead' ? 'dead' : 'swimming');
    this.revision++;
  }

  /** Swaps the demo stock; what is shown changes only while no saved tank is loaded. */
  setDemo(demo: readonly FishSpawn[]): boolean {
    this.demo = demo;
    if (this.loaded !== null || this.switching) return false;
    this.clear();
    this.showDemo();
    this.revision++;
    return true;
  }

  /**
   * False when `tankId` is not the loaded tank, e.g. a late event from a previous switch. A switch
   * leaves the tank empty rather than flashing the demo stock until the next tank arrives.
   */
  unload({ tankId, reason }: InteractionEvents['tank:unloaded']): boolean {
    if (this.loaded?.tankId !== tankId) return false;
    this.clear();
    this.loaded = null;
    this.switching = reason === 'switch';
    if (!this.switching) this.showDemo();
    this.revision++;
    return true;
  }

  /** The session says no saved tank is coming; false when the demo stock is already shown. */
  none(): boolean {
    if (!this.switching) return false;
    this.switching = false;
    this.showDemo();
    this.revision++;
    return true;
  }

  add({ tankId, fish, acclimate }: InteractionEvents['tank:fish-added']): RosterFish | null {
    if (!this.owns(tankId) || this.simIdByServer.has(fish.id)) return null;
    const phase = fish.status === 'dead' ? 'dead' : acclimate ? 'bagged' : 'swimming';
    const entry = this.insertSaved(fish, phase);
    if (phase === 'swimming') this.revision++;
    return entry;
  }

  release({ tankId, fishId }: InteractionEvents['tank:fish-released']): RosterFish | null {
    const entry = this.saved(tankId, fishId);
    if (entry?.phase !== 'bagged') return null;
    entry.phase = 'swimming';
    this.revision++;
    return entry;
  }

  /** A fish the roster did not know yet is added as already dead. */
  died({ tankId, fish }: InteractionEvents['tank:fish-died']): RosterFish | null {
    if (!this.owns(tankId)) return null;
    const entry = this.saved(tankId, fish.id);
    if (entry === undefined) return this.insertSaved(fish, 'dead');
    if (entry.phase === 'dead') return null;
    if (entry.phase === 'swimming') this.revision++;
    entry.phase = 'dead';
    entry.health = 0;
    return entry;
  }

  /** The stage each of `fish` has here, by sim id, for the fish this roster holds. */
  stagesOf({
    tankId,
    fish,
  }: InteractionEvents['tank:fish-updated']): Map<string, FishStage | null> {
    const stages = new Map<string, FishStage | null>();
    for (const f of fish) {
      const entry = this.saved(tankId, f.id);
      if (entry !== undefined) stages.set(entry.simId, entry.stage);
    }
    return stages;
  }

  /**
   * Moves living fish to the server's hunger, health, disease and stage. Never changes the swimming
   * set.
   */
  updated({ tankId, fish }: InteractionEvents['tank:fish-updated']): RosterFish[] {
    const changed: RosterFish[] = [];
    for (const f of fish) {
      const entry = this.saved(tankId, f.id);
      if (entry === undefined || entry.phase === 'dead' || f.status !== 'alive') continue;
      entry.health = f.health;
      entry.disease = f.disease;
      entry.hunger = f.hunger;
      entry.stage = f.stage;
      entry.bornAtMs = Date.parse(f.bornAt);
      changed.push(entry);
    }
    return changed;
  }

  removed({ tankId, fishId }: InteractionEvents['tank:fish-removed']): RosterFish | null {
    const entry = this.saved(tankId, fishId);
    if (entry === undefined) return null;
    this.fish.delete(entry.simId);
    this.simIdByServer.delete(fishId);
    if (entry.phase === 'swimming') this.revision++;
    return entry;
  }

  /**
   * Bites by sim id to bites by the id the rest of the app knows: the server id while a saved
   * tank is shown. Bites by fish that are no longer swimming here, or by another world's fish,
   * are dropped so their food stays in the water. Each bite passed on lowers the fish's hunger
   * as the server will (`applyEating` in the lifecycle).
   */
  translateAte(events: readonly AteEvent[]): AteEvent[] {
    const out: AteEvent[] = [];
    for (const e of events) {
      const entry = this.fish.get(e.fishId);
      if (entry?.phase !== 'swimming') continue;
      if (entry.hunger !== undefined) {
        entry.hunger = Math.max(0, entry.hunger - e.portion * HUNGER_PER_PORTION);
      }
      out.push({ fishId: entry.serverId ?? entry.key, foodId: e.foodId, portion: e.portion });
    }
    return out;
  }

  private owns(tankId: string): boolean {
    return this.loaded !== null && this.loaded.tankId === tankId;
  }

  private saved(tankId: string, serverId: string): RosterFish | undefined {
    if (!this.owns(tankId)) return undefined;
    const simId = this.simIdByServer.get(serverId);
    return simId === undefined ? undefined : this.fish.get(simId);
  }

  private clear(): void {
    this.fish.clear();
    this.simIdByServer.clear();
  }

  private showDemo(): void {
    for (const spawn of this.demo) {
      this.insert({
        simId: this.newSimId(),
        serverId: null,
        key: spawn.id,
        species: spawn.species,
        sex: null,
        lengthM: spawn.bodyLengthM,
        stage: null,
        bornAtMs: Number.NaN,
        phase: 'swimming',
        health: 1,
        disease: null,
      });
    }
  }

  private insertSaved(fish: Fish, phase: FishPhase): RosterFish {
    const personality = personalitySchema.safeParse(fish.personality);
    const entry: RosterFish = {
      simId: this.newSimId(),
      serverId: fish.id,
      key: fish.id,
      species: fish.species,
      sex: fish.sex,
      lengthM: fish.size,
      stage: fish.stage,
      bornAtMs: Date.parse(fish.bornAt),
      phase,
      health: fish.status === 'dead' ? 0 : fish.health,
      disease: fish.disease,
      hunger: fish.hunger,
      ...(personality.success ? { personality: personality.data } : {}),
    };
    this.insert(entry);
    this.simIdByServer.set(fish.id, entry.simId);
    return entry;
  }

  private insert(entry: RosterFish): void {
    this.fish.set(entry.simId, entry);
  }

  private newSimId(): string {
    return `fish-${this.nextId++}`;
  }
}

/** FNV-1a, for per-fish looks that stay the same across reloads. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
