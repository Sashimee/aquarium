import {
  chemistryParametersSchema,
  economySchema,
  type ChemistryParameters,
  type Economy,
} from '@aquarium/shared';

const economyFiles = import.meta.glob<unknown>('../../../../content/economy.json', {
  eager: true,
  import: 'default',
});
const chemistryFiles = import.meta.glob<unknown>('../../../../content/chemistry.json', {
  eager: true,
  import: 'default',
});

function only(files: Record<string, unknown>, name: string): unknown {
  const [raw] = Object.values(files);
  if (raw === undefined) throw new Error(`content/${name}.json is missing from this build`);
  return raw;
}

/** Prices shown to the player; the server charges from its own copy and never trusts these. */
export const BUNDLED_ECONOMY: Economy = economySchema.parse(only(economyFiles, 'economy'));

export const BUNDLED_CHEMISTRY: ChemistryParameters = chemistryParametersSchema.parse(
  only(chemistryFiles, 'chemistry'),
);
