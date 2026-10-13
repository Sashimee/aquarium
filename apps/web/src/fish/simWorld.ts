import type { Anchor, FishSpawn, SpeciesInput, WorldConfig } from '@aquarium/sim';
import type { SceneAnchor } from '../scene/anemone';
import { sceneAnchorsToSim, type DemoTank } from './demoStock';
import type { RosterFish } from './roster';
import { speciesInput } from './species';

/**
 * What every sim world is built from. The sim re-initialises on each change to the swimming set,
 * and a new world knows only its config, so the scene's homes live here and ride along each time.
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

  /** Null when none of `swimming` has content in this build, so there is no world to run. */
  config(swimming: readonly RosterFish[]): WorldConfig | null {
    const fish: FishSpawn[] = [];
    const species = new Map<string, SpeciesInput>();
    for (const f of swimming) {
      const input = speciesInput(f.species);
      if (input === undefined) continue;
      species.set(input.id, input);
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
      species: [...species.values()],
      fish,
      anchors: this.simAnchors,
    };
  }
}
