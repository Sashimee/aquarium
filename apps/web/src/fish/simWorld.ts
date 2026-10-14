import type { Anchor, FishSpawn, WorldConfig } from '@aquarium/sim';
import type { SceneAnchor } from '../scene/anemone';
import { sceneAnchorsToSim, type DemoTank } from './demoStock';
import type { RosterFish } from './roster';
import { allSpeciesInputs, speciesInput } from './species';

/**
 * What every sim world is built from. A world is rebuilt only when the tank or demo stock is
 * swapped; fish come and go through `layoutChanges`. A new world knows only its config, so the
 * scene's homes live here and ride along each time.
 */
export class SimWorldSpec {
  private simAnchors: readonly Anchor[] = [];

  constructor(
    private readonly demo: DemoTank,
    private readonly seed: number,
  ) {}

  get anchors(): readonly Anchor[] {
    return this.simAnchors;
  }

  /** Engine-space scene anchors; returns them in the sim frame for the running world. */
  setAnchors(anchors: readonly SceneAnchor[]): readonly Anchor[] {
    this.simAnchors = sceneAnchorsToSim(anchors, this.demo);
    return this.simAnchors;
  }

  /**
   * Null when none of `swimming` has content in this build, so there is no world to run. The world
   * knows every content species, since one can't be added to it later.
   */
  config(swimming: readonly RosterFish[]): WorldConfig | null {
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
      tank: this.demo.config.tank,
      species: allSpeciesInputs(),
      fish,
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
