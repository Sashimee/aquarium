import type { Biome, Coral, DecorItem, DecorLayout, Plant } from '@aquarium/shared';
import type { EventBus } from '../../engine/events';
import type { CatalogEntry } from '../../scene/assets';
import type { ScaleCap } from '../../scene/coralGrowth';
import type { InteractionEvents } from '../events';
import type { FeederLayer } from './feederLayer';
import { collidersFor } from './colliders';
import { growCorals, type GrownCorals } from './coralColliders';
import { pickCoral } from './coralPick';
import type { RayLike } from './footprint';
import { layoutKey } from './key';
import {
  composeLayout,
  numberPieces,
  sanitizeLayout,
  splitLayout,
  type Piece,
  type PlantFit,
} from './layout';
import { growPlants, type GrownPlants } from './plantColliders';
import { FEEDER_SPEC, specsFromCatalog, type DecorSpec } from './spec';

/** What the decor layer needs from the tank scene; `TankScene` satisfies it. */
export interface DecorScenePort {
  readonly biome: Biome;
  /** The preset's own rocks, wood and ornaments: the layout of a tank that was never edited. */
  readonly presetHardDecor: readonly DecorItem[];
  /** Anemones and procedural corals, which the player cannot move. */
  readonly fixedDecor: readonly DecorItem[];
  catalogEntries(): Iterable<CatalogEntry>;
  /** Water surface height, so saved plants taller than the water can be shrunk on load. */
  readonly waterTop?: number;
  groundHeight(x: number, z: number): number;
  setHardDecor(items: readonly DecorItem[]): Promise<void>;
  moveHardDecor(index: number, item: DecorItem): void;
}

type CoralBounds = {
  min: [number, number, number];
  max: [number, number, number];
};

/** What the world needs to size grown corals the way the scene draws them. */
export interface CoralEnv {
  cap(): ScaleCap;
  /** Model-space bounds of a procedural coral, whose asset ids are not in the catalog. */
  proceduralBounds(assetId: string): CoralBounds | null;
}

/**
 * The placed pieces as the scene, the sim and the server see them. Applying a saved layout and
 * editing both go through here so the three never disagree.
 */
export class DecorWorld {
  readonly specs: ReadonlyMap<string, DecorSpec>;
  private current: readonly Piece[];
  private applied: Promise<void> = Promise.resolve();
  private unmanaged: readonly DecorItem[];
  private corals: readonly Coral[] = [];
  private plants: readonly Plant[] = [];
  private readonly catalogBounds = new Map<string, CoralBounds>();
  private presetLayoutKey: string;
  /** Says what loading a saved layout had to drop; shown while decorating. */
  notice: string | null = null;

  constructor(
    private readonly scene: DecorScenePort,
    private readonly interaction: EventBus<InteractionEvents>,
    private readonly feeders: Pick<FeederLayer, 'sync' | 'dispose'>,
    private readonly coralEnv?: CoralEnv,
  ) {
    const entries = [...scene.catalogEntries()];
    this.specs = specsFromCatalog(entries);
    for (const entry of entries) {
      if (entry.kind === 'coral' && entry.bounds) {
        this.catalogBounds.set(entry.id, {
          min: [...entry.bounds.min],
          max: [...entry.bounds.max],
        });
      }
    }
    this.unmanaged = scene.fixedDecor;
    this.current = numberPieces(scene.presetHardDecor);
    this.presetLayoutKey = layoutKey(scene.presetHardDecor);
  }

  get biome(): Biome {
    return this.scene.biome;
  }

  get pieces(): readonly Piece[] {
    return this.current;
  }

  groundHeight(x: number, z: number): number {
    return this.scene.groundHeight(x, z);
  }

  layout(pieces: readonly Piece[] = this.current): DecorLayout {
    return composeLayout(this.unmanaged, pieces);
  }

  /** Whether `layout` is the unedited preset, which a fresh tank is saved as. */
  isPresetLayout(layout: readonly DecorItem[]): boolean {
    return layoutKey(splitLayout(layout, this.specs).pieces) === this.presetLayoutKey;
  }

  /** Shows a saved layout; a tank that was never edited keeps the preset, while an emptied one shows bare. */
  showSaved(layout: readonly DecorItem[], edited: boolean): Promise<void> {
    if (!edited) return this.showPreset();
    const clean = sanitizeLayout(layout, this.scene.biome, this.fit());
    const parts: string[] = [];
    const n = clean.dropped;
    if (n > 0) {
      parts.push(
        `${n} saved ${n === 1 ? 'piece does' : 'pieces do'} not fit this tank and ${n === 1 ? 'was' : 'were'} removed.`,
      );
    }
    const m = clean.shrunk;
    if (m > 0) {
      parts.push(
        `${m} ${m === 1 ? 'plant was' : 'plants were'} too tall for the water and ${m === 1 ? 'was' : 'were'} shrunk.`,
      );
    }
    this.notice =
      parts.length === 0 ? null : `${parts.join(' ')} Your next change saves the cleaned layout.`;
    const { pieces } = splitLayout(clean.layout, this.specs);
    return this.show(numberPieces(pieces));
  }

  private fit(): PlantFit | undefined {
    const { waterTop } = this.scene;
    if (waterTop === undefined) return undefined;
    return { specs: this.specs, waterTop };
  }

  showPreset(): Promise<void> {
    this.notice = null;
    return this.show(numberPieces(this.scene.presetHardDecor));
  }

  /** Replaces the whole set of pieces (added, removed or reordered ones). */
  show(pieces: readonly Piece[]): Promise<void> {
    this.current = pieces;
    this.syncFeeders();
    this.emitColliders();
    const hard = pieces.filter((p) => p.item.assetId !== FEEDER_SPEC.assetId).map((p) => p.item);
    const run = this.applied.catch(() => undefined).then(() => this.scene.setHardDecor(hard));
    this.applied = run;
    return run;
  }

  /** Live move of one piece during a drag or drop, without touching the sim. */
  preview(piece: Piece): void {
    const index = this.current.findIndex((p) => p.id === piece.id);
    if (index === -1) return;
    this.current = this.current.map((p, i) => (i === index ? piece : p));
    if (piece.item.assetId === FEEDER_SPEC.assetId) {
      this.syncFeeders();
      return;
    }
    const hardIndex = this.current
      .slice(0, index)
      .filter((p) => p.item.assetId !== FEEDER_SPEC.assetId).length;
    this.scene.moveHardDecor(hardIndex, piece.item);
  }

  /** The coral state to size the corals' colliders by; absent or empty is the corals as placed. */
  setCorals(corals: readonly Coral[] | undefined): void {
    this.corals = corals ?? [];
    this.emitColliders();
  }

  /** The plant state to size the plants' colliders by, and to give offsets colliders of their own. */
  setPlants(plants: readonly Plant[] | undefined): void {
    this.plants = plants ?? [];
    this.emitColliders();
  }

  emitColliders(): void {
    const plants = this.grownPlants();
    const grown = this.grownCorals(plants.pieces);
    const colliders = [
      ...grown.pieces.flatMap((p) => {
        const spec = this.specs.get(p.item.assetId);
        return spec ? collidersFor(p.id, spec, p.item) : [];
      }),
      ...plants.extra,
      ...grown.extra,
    ];
    this.interaction.emit('decor:colliders', { colliders });
  }

  /** The coral a world-space ray enters first, at the size and spot it is drawn. */
  coralAt(ray: RayLike): Coral | null {
    const env = this.coralEnv;
    if (!env) return null;
    return pickCoral(this.grownCorals().placed, this.specs, this.boundsOf(env), ray);
  }

  private boundsOf(env: CoralEnv): (assetId: string) => CoralBounds | null {
    return (assetId) => this.catalogBounds.get(assetId) ?? env.proceduralBounds(assetId);
  }

  private grownPlants(): GrownPlants {
    const { waterTop } = this.scene;
    if (waterTop === undefined || this.plants.length === 0) {
      return { pieces: this.current, extra: [] };
    }
    return growPlants({
      pieces: this.current,
      specs: this.specs,
      plants: this.plants,
      ground: (x, z) => this.scene.groundHeight(x, z),
      waterTop,
    });
  }

  private grownCorals(pieces: readonly Piece[] = this.current): GrownCorals {
    const env = this.coralEnv;
    if (!env || this.corals.length === 0) return { pieces, extra: [], placed: [] };
    return growCorals({
      pieces,
      fixed: this.unmanaged,
      specs: this.specs,
      corals: this.corals,
      cap: env.cap(),
      ground: (x, z) => this.scene.groundHeight(x, z),
      boundsOf: this.boundsOf(env),
    });
  }

  dispose(): void {
    this.feeders.dispose();
  }

  private syncFeeders(): void {
    this.feeders.sync(this.current.filter((p) => p.item.assetId === FEEDER_SPEC.assetId));
  }
}
