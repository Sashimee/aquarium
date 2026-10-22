import type { ChemistryParameters, Economy, Tank } from '@aquarium/shared';

export type DoseType = 'salt_dose' | 'buffer_dose' | 'add_botanicals';

export const doseButtonId = (type: DoseType): string => `dose-${type}`;

export interface DoseOption {
  type: DoseType;
  label: string;
  hint: string;
  price: number;
  disabledReason: string | null;
}

export function doseOptions(
  tank: Tank,
  chemistry: ChemistryParameters,
  economy: Economy,
): DoseOption[] {
  const { biome } = tank;
  const options: DoseOption[] = [];

  const saltMix = chemistry.salinity.target[biome];
  if (saltMix > 0) {
    options.push({
      type: 'salt_dose',
      label: 'Add salt mix',
      hint: 'Raises the salinity toward this tank type’s level.',
      price: 0,
      disabledReason:
        tank.chemistry.salinity >= saltMix
          ? 'The water is already as salty as a salt dose can make it.'
          : null,
    });
  }

  const khCeiling = chemistry.kh.bufferCeiling[biome];
  if (khCeiling > 0) {
    options.push({
      type: 'buffer_dose',
      label: 'Add buffer',
      hint: 'Raises carbonate hardness, which steadies the pH.',
      price: economy.items.consumables.bufferDose,
      disabledReason:
        tank.chemistry.kh >= khCeiling
          ? 'The water is already as hard as a buffer dose can make it.'
          : null,
    });
  }

  const tanninCeiling = chemistry.tannin.ceiling[biome];
  if (tanninCeiling > 0) {
    options.push({
      type: 'add_botanicals',
      label: 'Add botanicals',
      hint: 'Leaf litter and cones tint the water and lower the pH a little.',
      price: economy.items.consumables.botanicals,
      disabledReason:
        tank.water.tannin >= tanninCeiling
          ? 'The water is already as dark as botanicals can make it.'
          : null,
    });
  }

  return options;
}
