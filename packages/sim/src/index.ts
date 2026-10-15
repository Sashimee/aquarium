export { Rng, type RngState } from './rng.ts';
export {
  DEG,
  quatFromBasis,
  quatFromYawPitchRoll,
  rotateByQuat,
  wrapAngle,
  type Vec3,
} from './math.ts';
export {
  DIET_RANK_DECAY,
  DRAG_COEFFICIENT_L2,
  FLIP_PEAK_OVER_MEAN,
  toSimSpecies,
  TRAITS,
  WATER_DENSITY,
  type Gait,
  type HomeKind,
  type SimSpecies,
  type SimWalking,
  type SpeciesInput,
  type Trait,
} from './species.ts';
export { BEHAVIOUR, type Anchor, type Stimulus } from './behaviour.ts';
export {
  FOOD_PARTICLES,
  FOOD_STRIDE,
  FOOD_TYPES,
  FoodField,
  MAX_FOOD_ID,
  MAX_FOOD_PARTICLES,
  type AteEvent,
} from './food.ts';
export { WALK, Walkers } from './walk.ts';
export {
  CARCASS,
  carcassFate,
  carcassSettleS,
  sinkingCarcass,
  sinkSpeed,
  type CarcassFate,
  type CarcassPose,
  type CarcassStart,
} from './carcass.ts';
export { FEEDING, gutForHunger } from './feeding.ts';
export { CURIOSITY } from './curiosity.ts';
export { compileCollider, DecorField, UnionSdf, type Point3 } from './decor.ts';
export { Basin, type TankDimensions } from './basin.ts';
export { resolvePenetration, TankSdf, type Sdf } from './sdf.ts';
export { pairwiseDistanceSq, selectNearest } from './neighbours.ts';
export {
  FishState,
  interpolateSnapshots,
  SNAPSHOT_STRIDE,
  SnapshotField,
  SnapshotInterpolator,
  type Snapshot,
} from './snapshot.ts';
export {
  STEERING,
  STEP_DT,
  STEP_HZ,
  World,
  type AnyWorldConfig,
  type FishPlacement,
  type FishSpawn,
  type TankSpaceWorldConfig,
  type WorldConfig,
} from './world.ts';
export {
  createSimHost,
  SimClient,
  type MessagePortLike,
  type SimCommand,
  type SimEvent,
  type SimHost,
  type SimHostOptions,
  type SimAte,
  type SimClientPort,
  type SimGrazeReach,
  type SimLayout,
  type SimReady,
} from './bridge.ts';
