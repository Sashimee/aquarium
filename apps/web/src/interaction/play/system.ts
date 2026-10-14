import { Raycaster, Vector2 } from 'three/webgpu';
import type { Engine } from '../../engine/Engine';
import type { EventBus } from '../../engine/events';
import { waterBounds } from '../../engine/tank/dimensions';
import { FeedGate } from '../../sync/feedGate';
import type { InteractionEvents } from '../events';
import { FoodLink, type FoodBridge } from '../food/link';
import { FoodField } from '../food/particles';
import { sceneToSim } from '../food/simSpace';
import { BubbleField } from './bubbles';
import { PlayController, type Ray, type StimulusLike } from './controller';
import { RippleField } from './ripples';
import { PlayVisuals } from './visuals';

/** The parts of the scene the play layer reads. */
export interface PlayScene {
  groundHeight(x: number, z: number): number;
  readonly current: { sample(x: number, y: number, z: number, out: Float64Array | number[]): void };
}

export interface PlaySimBridge extends FoodBridge {
  startle?(stimulus: StimulusLike): void;
  netTap?(ray: Ray): void;
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
  const toSim = sceneToSim((x, z) => scene.groundHeight(x, z));
  const link = new FoodLink(food, sim, toSim, (eaten) => interaction.emit('food:ate', { eaten }));
  const bubbles = new BubbleField(box.max.y);
  const ripples = new RippleField();
  const visuals = new PlayVisuals((x, z) => scene.groundHeight(x, z));
  engine.scene.add(visuals.group);

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const canvas = engine.renderer.domElement;
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
    toSim,
    setLaserDot: (p) => visuals.setLaser(p),
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
      link.dispose();
      visuals.dispose();
    },
  };
}
