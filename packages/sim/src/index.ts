export { Rng, type RngState } from './rng.ts';
export { DEG, quatFromYawPitchRoll, rotateByQuat, wrapAngle, type Vec3 } from './math.ts';
export {
  DIET_RANK_DECAY,
  DRAG_COEFFICIENT_L2,
  toSimSpecies,
  TRAITS,
  WATER_DENSITY,
  type Gait,
  type HomeKind,
  type SimSpecies,
  type SpeciesInput,
  type Trait,
} from './species.ts';
export { BEHAVIOUR, type Anchor, type Stimulus } from './behaviour.ts';
export {
  FOOD_PARTICLES,
  FOOD_POSITION_SLACK_M,
  FOOD_STRIDE,
  FOOD_TYPES,
  FoodField,
  MAX_FOOD_ID,
  MAX_FOOD_PARTICLES,
  type AteEvent,
} from './food.ts';
export { FEEDING } from './feeding.ts';
export {
  compileCollider,
  DecorField,
  UnionSdf,
  type DecorCollider,
  type DecorShape,
  type Point3,
} from './decor.ts';
export { resolvePenetration, TankSdf, type Sdf, type TankDimensions } from './sdf.ts';
export { pairwiseDistanceSq, selectNearest } from './neighbours.ts';
export {
  FishState,
  interpolateSnapshots,
  SNAPSHOT_STRIDE,
  SnapshotField,
  SnapshotInterpolator,
  type Snapshot,
} from './snapshot.ts';
export { STEERING, STEP_DT, STEP_HZ, World, type FishSpawn, type WorldConfig } from './world.ts';
export {
  createSimHost,
  SimClient,
  type MessagePortLike,
  type SimCommand,
  type SimEvent,
  type SimHost,
  type SimHostOptions,
  type SimAte,
  type SimReady,
} from './bridge.ts';
