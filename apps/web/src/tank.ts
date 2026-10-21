// Everything main.ts needs that pulls in three. main.ts imports this lazily so three is not in the
// initial JS that index.html references (PLAN §2.7 budget); keep three-free modules out of here.
export { Engine } from './engine/Engine';
export { DEFAULT_TANK, framingScale } from './engine/tank/dimensions';
export { FeederLayer } from './interaction/decor/feederLayer';
export { createPlaySystem } from './interaction/play/system';
export { mountBiomeScene } from './scene';
export { pumpFieldFor } from './sync/pumpField';
