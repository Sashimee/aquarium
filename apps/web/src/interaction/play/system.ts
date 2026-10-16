import { Raycaster, Vector2 } from 'three/webgpu';
import type { Engine } from '../../engine/Engine';
import type { EventBus } from '../../engine/events';
import { waterBounds } from '../../engine/tank/dimensions';
import { FeedGate } from '../../sync/feedGate';
import type { Vec3 } from '../camera';
import type { InteractionEvents } from '../events';
import { FoodLink, type FoodBridge } from '../food/link';
import type { ReachBridge } from '../food/clipReach';
import { FoodField } from '../food/particles';
import { sceneToSim } from '../food/simSpace';
import { BubbleField } from './bubbles';
import {
  PlayController,
  type Ray,
  type SimToy,
  type StimulusLike,
  type ToyNudge,
} from './controller';
import { FeedingGame, localBest } from './game';
import { RippleField } from './ripples';
import { PlayVisuals } from './visuals';
import { speciesInput } from '../../fish/species';

/** The parts of the scene the play layer reads. */
export interface PlayScene {
  groundHeight(x: number, z: number): number;
  readonly current: { sample(x: number, y: number, z: number, out: Float64Array | number[]): void };
}

export interface PlaySimBridge extends FoodBridge, ReachBridge {
  startle?(stimulus: StimulusLike): void;
  setLure?(position: readonly [number, number, number] | null): void;
  netTap?(ray: Ray): void;
  pickFish?(ray: Ray): (() => Vec3 | null) | null;
  /** The toys as points of interest. A mirror is where a betta flares; a ball is a thing to nudge. */
  setToys?(toys: readonly SimToy[]): void;
  /** Fish bumping the ball; returns the unsubscribe. */
  onToyNudge?(listener: (nudge: ToyNudge) => void): () => void;
  /** A swimming fish's position by server id, in scene space, or null. */
  fishPoint?(fishId: string): Vec3 | null;
}

export interface PlaySystem {
  readonly controller: PlayController;
  readonly food: FoodField;
  dispose(): void;
}

export function createPlaySystem(
  engine: Engine,
  scene: PlayScene,
  interaction: EventBus<InteractionEvents>,
  sim: PlaySimBridge = {},
  // Passed in so the feed cooldown survives the play system being rebuilt with a new scene.
  gate: FeedGate = new FeedGate(),
): PlaySystem {
  const box = waterBounds(engine.tank.dimensions);
  const food = new FoodField({
    bounds: {
      minX: box.min.x,
      maxX: box.max.x,
      minZ: box.min.z,
      maxZ: box.max.z,
      waterTop: box.max.y,
    },
    groundHeight: (x, z) => scene.groundHeight(x, z),
    current: (x, y, z, out) => scene.current.sample(x, y, z, out),
  });
  const link = new FoodLink(food, sim, sceneToSim, (eaten) =>
    interaction.emit('food:ate', { eaten }),
  );
  const bubbles = new BubbleField(box.max.y);
  const ripples = new RippleField();
  const visuals = new PlayVisuals();
  const game = new FeedingGame(
    localBest(safeStorage(), (message, cause) => console.error(message, cause)),
  );
  engine.scene.add(visuals.group);

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const canvas = engine.renderer.domElement;
  let lured = false;
  const lureSim = new Float64Array(3);
  const controller = new PlayController({
    rayAt(x, y) {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return null;
      ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
      raycaster.setFromCamera(ndc, engine.camera);
      const { origin, direction } = raycaster.ray;
      return {
        origin: { x: origin.x, y: origin.y, z: origin.z },
        dir: { x: direction.x, y: direction.y, z: direction.z },
      };
    },
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
    food,
    link,
    bubbles,
    ripples,
    gate,
    events: interaction,
    startle: sim.startle?.bind(sim),
    netTap: sim.netTap?.bind(sim),
    pickFish: sim.pickFish?.bind(sim),
    toSim: sceneToSim,
    reach: sim,
    lure(p) {
      if (p === null && !lured) return;
      lured = p !== null;
      if (p === null) return sim.setLure?.(null);
      sceneToSim(p.x, p.y, p.z, lureSim);
      sim.setLure?.([lureSim[0] ?? 0, lureSim[1] ?? 0, lureSim[2] ?? 0]);
    },
    setLaserDot: (p) => visuals.setLaser(p),
    current: (x, y, z, out) => scene.current.sample(x, y, z, out),
    toyVisuals: visuals,
    setToys: sim.setToys?.bind(sim),
    onToyNudge: sim.onToyNudge?.bind(sim),
    fishPoint: sim.fishPoint?.bind(sim),
    boldnessOf: (species) => speciesInput(species)?.behaviour.boldness,
    game,
    report: (message, cause) => console.error(message, cause),
    now: () => performance.now(),
  });

  const stopRequests = interaction.on('play:request-tool', ({ tool }) => controller.setTool(tool));
  const stopFrame = engine.onFrame((deltaS) => {
    controller.update(deltaS);
    visuals.update(food, bubbles, ripples);
  });

  interaction.emit('play:ready', {});

  return {
    controller,
    food,
    dispose() {
      stopFrame();
      stopRequests();
      controller.dispose();
      sim.setLure?.(null);
      interaction.emit('toys:changed', { mirror: false, ball: false });
      interaction.emit('game:state', { view: game.cancel() });
      link.dispose();
      visuals.dispose();
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Blocked storage (cookies off) throws on access; the best then lasts the session only.
    return null;
  }
}
