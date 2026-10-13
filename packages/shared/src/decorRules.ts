import { PROCEDURAL_EUPHYLLIA_ID, type Biome, type DecorItem } from './common.js';

/** The tank every account gets today: 120 x 50 x 50 cm with 10 mm glass, in metres. */
export const DEFAULT_TANK_METRES = {
  length: 1.2,
  depth: 0.5,
  height: 0.5,
  glass: 0.01,
} as const;

const ROCKS = ['boulder-01', 'coast-rocks-05'] as const;

/**
 * Asset ids a saved layout may hold per biome: the rocks, wood, ornaments, corals, anemones and
 * plants in `apps/web/public/assets/index.json`, plus the procedural euphyllia ids. The vacation
 * feeder is allowed everywhere and is handled by the server separately.
 */
export const DECOR_ASSET_IDS: Readonly<Record<Biome, ReadonlySet<string>>> = {
  freshwater: new Set([
    ...ROCKS,
    'dead-quiver-trunk',
    'dead-tree-trunk-02',
    'driftwood-branch',
    'java-fern',
    'pond-weed',
    'red-tiger-lotus',
    'staurogyne-repens',
    'universal-plant',
    'vallisneria',
    'water-plant',
  ]),
  reef: new Set([
    ...ROCKS,
    'reef-arch',
    'lambis-shell',
    'acropora-cytherea',
    'acropora-palmata',
    'brain-coral',
    'blue-sea-anemone',
    'host-anemone',
  ]),
};

export function isDecorAssetForBiome(biome: Biome, assetId: string): boolean {
  return (
    DECOR_ASSET_IDS[biome].has(assetId) ||
    (biome === 'reef' && PROCEDURAL_EUPHYLLIA_ID.test(assetId))
  );
}

/** Where a piece's origin may be: inside the glass, from the underside of the tank up to the rim. */
export function decorPositionLimits(tank: typeof DEFAULT_TANK_METRES = DEFAULT_TANK_METRES): {
  readonly x: number;
  readonly z: number;
  readonly yMax: number;
} {
  return {
    x: tank.length / 2 - tank.glass,
    z: tank.depth / 2 - tank.glass,
    yMax: tank.height,
  };
}

export interface DecorProblem {
  readonly index: number;
  readonly field: 'assetId' | 'position';
  readonly message: string;
}

/** Problems with a layout that the schema cannot see; the feeder id is passed in because it lives in the sim. */
export function findDecorProblems(
  biome: Biome,
  layout: readonly DecorItem[],
  feederAssetId: string,
): DecorProblem[] {
  const limits = decorPositionLimits();
  const problems: DecorProblem[] = [];
  let feeders = 0;
  layout.forEach((item, index) => {
    if (item.assetId === feederAssetId) {
      feeders += 1;
      if (feeders > 1) {
        problems.push({ index, field: 'assetId', message: 'A tank holds one vacation feeder.' });
      }
    } else if (!isDecorAssetForBiome(biome, item.assetId)) {
      problems.push({
        index,
        field: 'assetId',
        message: `"${item.assetId}" is not available in a ${biome} tank.`,
      });
    }
    const [x, y, z] = item.position;
    if (Math.abs(x) > limits.x || Math.abs(z) > limits.z || y < 0 || y > limits.yMax) {
      problems.push({
        index,
        field: 'position',
        message: `Position is outside the tank: x within ±${limits.x} m, z within ±${limits.z} m, y within 0 to ${limits.yMax} m.`,
      });
    }
  });
  return problems;
}
