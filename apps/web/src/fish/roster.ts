import type { Biome, Fish } from '@aquarium/shared';
import type { AteEvent, FishSpawn } from '@aquarium/sim';
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
  /** Undefined means the species' adult length. */
  readonly lengthM: number | undefined;
  phase: FishPhase;
  /** 0 dead .. 1 healthy, as of the last server snapshot that carried this fish. */
  health: number;
}

/**
 * Which fish the tank shows: the demo stock, or the saved tank's fish from the `tank:*` events.
 * `revision` changes exactly when the swimming set does, i.e. when the sim needs a new world.
 */
export class TankRoster {
  private readonly fish = new Map<string, RosterFish>();
  private readonly simIdByServer = new Map<string, string>();
  private loaded: { readonly tankId: string; readonly biome: Biome } | null = null;
  private nextId = 0;
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

  simIdOf(serverId: string): string | undefined {
    return this.simIdByServer.get(serverId);
  }

  serverIdOf(simId: string): string | undefined {
    return this.fish.get(simId)?.serverId ?? undefined;
  }

  load({ tankId, biome, fish }: InteractionEvents['tank:loaded']): void {
    this.clear();
    this.loaded = { tankId, biome };
    for (const f of fish) this.insertSaved(f, f.status === 'dead' ? 'dead' : 'swimming');
    this.revision++;
  }

  /** Swaps the demo stock; what is shown changes only while no saved tank is loaded. */
  setDemo(demo: readonly FishSpawn[]): boolean {
    this.demo = demo;
    if (this.loaded !== null) return false;
    this.clear();
    this.showDemo();
    this.revision++;
    return true;
  }

  /** False when `tankId` is not the loaded tank, e.g. a late event from a previous switch. */
  unload({ tankId }: InteractionEvents['tank:unloaded']): boolean {
    if (this.loaded?.tankId !== tankId) return false;
    this.clear();
    this.loaded = null;
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
   * are dropped so their food stays in the water.
   */
  translateAte(events: readonly AteEvent[]): AteEvent[] {
    const out: AteEvent[] = [];
    for (const e of events) {
      const entry = this.fish.get(e.fishId);
      if (entry?.phase !== 'swimming') continue;
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
        lengthM: spawn.bodyLengthM,
        phase: 'swimming',
        health: 1,
      });
    }
  }

  private insertSaved(fish: Fish, phase: FishPhase): RosterFish {
    const entry: RosterFish = {
      simId: this.newSimId(),
      serverId: fish.id,
      key: fish.id,
      species: fish.species,
      lengthM: fish.size,
      phase,
      health: fish.status === 'dead' ? 0 : fish.health,
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
