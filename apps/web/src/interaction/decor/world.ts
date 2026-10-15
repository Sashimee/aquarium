import type { Biome, DecorItem, DecorLayout } from '@aquarium/shared';
import type { EventBus } from '../../engine/events';
import type { CatalogEntry } from '../../scene/assets';
import type { InteractionEvents } from '../events';
import type { FeederLayer } from './feederLayer';
import { collidersFor } from './colliders';
import { layoutKey } from './key';
import { composeLayout, numberPieces, sanitizeLayout, splitLayout, type Piece } from './layout';
import { FEEDER_SPEC, specsFromCatalog, type DecorSpec } from './spec';

/** What the decor layer needs from the tank scene; `TankScene` satisfies it. */
export interface DecorScenePort {
  readonly biome: Biome;
  /** The preset's own rocks, wood and ornaments: the layout of a tank that was never edited. */
  readonly presetHardDecor: readonly DecorItem[];
  /** Anemones and procedural corals, which the player cannot move. */
  readonly fixedDecor: readonly DecorItem[];
  catalogEntries(): Iterable<CatalogEntry>;
  groundHeight(x: number, z: number): number;
  setHardDecor(items: readonly DecorItem[]): Promise<void>;
  moveHardDecor(index: number, item: DecorItem): void;
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
  private presetLayoutKey: string;
  /** Says what loading a saved layout had to drop; shown while decorating. */
  notice: string | null = null;

  constructor(
    private readonly scene: DecorScenePort,
    private readonly interaction: EventBus<InteractionEvents>,
    private readonly feeders: Pick<FeederLayer, 'sync' | 'dispose'>,
  ) {
    this.specs = specsFromCatalog(scene.catalogEntries());
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
    const clean = sanitizeLayout(layout, this.scene.biome);
    const n = clean.dropped;
    this.notice =
      n === 0
        ? null
        : `${n} saved ${n === 1 ? 'piece does' : 'pieces do'} not fit this tank and ${n === 1 ? 'was' : 'were'} removed. Your next change saves the cleaned layout.`;
    const { pieces } = splitLayout(clean.layout, this.specs);
    return this.show(numberPieces(pieces));
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

  emitColliders(): void {
    const colliders = this.current.flatMap((p) => {
      const spec = this.specs.get(p.item.assetId);
      return spec ? collidersFor(p.id, spec, p.item) : [];
    });
    this.interaction.emit('decor:colliders', { colliders });
  }

  dispose(): void {
    this.feeders.dispose();
  }

  private syncFeeders(): void {
    this.feeders.sync(this.current.filter((p) => p.item.assetId === FEEDER_SPEC.assetId));
  }
}
