import type { Collider } from '@aquarium/shared';
import type { Anchor, FishSpawn, TankSpaceWorldConfig } from '@aquarium/sim';
import type { SceneAnchor } from '../scene/anemone';
import { sceneAnchorsToSim, type DemoTank } from './demoStock';
import type { RosterFish } from './roster';
import { allSpeciesInputs, speciesInput } from './species';

/**
 * What every sim world is built from. A world is rebuilt only when the tank or demo stock is
 * swapped; fish come and go through `layoutChanges`. A new world knows only its config, so the
 * scene's homes and colliders live here and ride along each time.
 */
export class SimWorldSpec {
  private simAnchors: readonly Anchor[] = [];
  /** Already in the shared format and tank space; see `SimColliders`. */
  decor: readonly Collider[] = [];

  constructor(
    private readonly demo: DemoTank,
    private readonly seed: number,
  ) {}

  get anchors(): readonly Anchor[] {
    return this.simAnchors;
  }

  /** Scene anchors; returns them as the sim takes them, for the running world. */
  setAnchors(anchors: readonly SceneAnchor[]): readonly Anchor[] {
    this.simAnchors = sceneAnchorsToSim(anchors, this.demo);
    return this.simAnchors;
  }

  /**
   * Null when none of `swimming` has content in this build, so there is no world to run. The world
   * knows every content species, since one can't be added to it later.
   */
  config(swimming: readonly RosterFish[]): TankSpaceWorldConfig | null {
    const fish: FishSpawn[] = [];
    for (const f of swimming) {
      if (speciesInput(f.species) === undefined) continue;
      fish.push(
        f.lengthM === undefined
          ? { id: f.simId, species: f.species }
          : { id: f.simId, species: f.species, bodyLengthM: f.lengthM },
      );
    }
    if (fish.length === 0) return null;
    return {
      seed: this.seed,
      space: this.demo.config.space,
      species: allSpeciesInputs(),
      fish,
      decor: this.decor,
      anchors: this.simAnchors,
    };
  }
}

/** What turns a running world holding `inWorld` into one holding exactly `wanted`. */
export function layoutChanges(
  inWorld: Iterable<string>,
  wanted: readonly FishSpawn[],
): { readonly remove: string[]; readonly add: FishSpawn[] } {
  const present = new Set(inWorld);
  const keep = new Set(wanted.map((f) => f.id));
  return {
    remove: [...present].filter((id) => !keep.has(id)),
    add: wanted.filter((f) => !present.has(f.id)),
  };
}
