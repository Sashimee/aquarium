import {
  equipmentProblems,
  type Biome,
  type ChemistryParameters,
  type Economy,
  type Equipment,
  type Tank,
} from '@aquarium/shared';

export type Device = keyof Economy['items']['equipment'];

export const DEVICES: readonly Device[] = ['heater', 'filter', 'light', 'co2', 'waveMaker'];

export const DEVICE_LABEL: Record<Device, string> = {
  heater: 'Heater',
  filter: 'Filter',
  light: 'Lamp',
  co2: 'CO₂ system',
  waveMaker: 'Wave maker',
};

export function equipmentRef(device: Device, tier: number): string {
  return `equipment:${device}:${tier}`;
}

function atTier(values: readonly number[], tier: number): number {
  return values[Math.min(tier, values.length - 1)] ?? 1;
}

const times = (n: number): string => `${Number(n.toFixed(2))} times`;

function heaterWarmupSpeedup(tier: number, cp: ChemistryParameters): number {
  const { driftPerHour, heaterWarmupRatePerHourPerTier: rate } = cp.temperature;
  return Math.max(driftPerHour, rate * tier) / Math.max(driftPerHour, rate);
}

/** What a tier does in the water model, worded from the same numbers the server steps with. */
export function effectText(device: Device, tier: number, cp: ChemistryParameters): string {
  switch (device) {
    case 'heater':
      return tier === 1
        ? `Warms the tank to the temperature its fish like. One heater already reaches 31 °C in a ${cp.temperature.roomC} °C room.`
        : `Warms a cold tank ${times(heaterWarmupSpeedup(tier, cp))} as fast as tier 1 does, then settles on the same temperature.`;
    case 'filter': {
      const share = Math.round(Math.min(1, tier * cp.bacteria.mediaCapacityPerFilterTier) * 100);
      return `Its media hosts up to ${share}% of the bacteria a full tank can use, which clear ammonia and nitrite.`;
    }
    case 'light': {
      const base = atTier(cp.equipment.light.algaeGrowthPerTier, 1);
      const here = atTier(cp.equipment.light.algaeGrowthPerTier, tier);
      return tier === 1
        ? 'Algae grows only while the lamp is on. The schedule below sets the hours and the strength.'
        : `A stronger lamp: algae grows ${times(here / base)} as fast as with tier 1 while it is on, and none while it is off.`;
    }
    case 'co2': {
      const drop = atTier(cp.equipment.co2.phDropPerTier, tier);
      const algae = atTier(cp.equipment.co2.algaeFactorPerTier, tier);
      return `Lowers the pH by ${drop} and algae grows ${times(algae)} as fast. Check the water test: fish that need hard, alkaline water suffer when the pH falls.`;
    }
    case 'waveMaker': {
      const algae = atTier(cp.equipment.waveMaker.algaeFactorPerTier, tier);
      return `Moving water: algae grows ${times(algae)} as fast.`;
    }
  }
}

export function devicesForBiome(biome: Biome): Device[] {
  const probe = (device: 'co2' | 'waveMaker'): Equipment => ({
    filter: { tier: 0 },
    heater: { tier: 0 },
    light: { tier: 0, intensity: 0.5, onHour: 8, offHour: 20 },
    co2: { tier: device === 'co2' ? 1 : 0 },
    waveMaker: { tier: device === 'waveMaker' ? 1 : 0 },
  });
  return DEVICES.filter(
    (d) => (d !== 'co2' && d !== 'waveMaker') || equipmentProblems(biome, probe(d)).length === 0,
  );
}

export type TierState = 'installed' | 'better-installed' | 'available';

export interface TierOffer {
  tier: number;
  price: number;
  state: TierState;
  /** Lower tiers that stay unbought when this one is chosen; the price is still this tier's own. */
  skipped: number;
  effect: string;
}

export interface DeviceOffer {
  device: Device;
  label: string;
  currentTier: number;
  tiers: TierOffer[];
}

export function deviceOffers(
  tank: Pick<Tank, 'biome' | 'equipment'>,
  economy: Economy,
  cp: ChemistryParameters,
): DeviceOffer[] {
  return devicesForBiome(tank.biome).map((device) => {
    const currentTier = tank.equipment[device].tier;
    const tiers = economy.items.equipment[device].map((price, i): TierOffer => {
      const tier = i + 1;
      const state: TierState =
        tier === currentTier ? 'installed' : tier < currentTier ? 'better-installed' : 'available';
      return {
        tier,
        price,
        state,
        skipped: state === 'available' ? tier - currentTier - 1 : 0,
        effect: effectText(device, tier, cp),
      };
    });
    return { device, label: DEVICE_LABEL[device], currentTier, tiers };
  });
}

export type EquipmentChoice =
  { ok: true; ref: string; price: number; skipped: number } | { ok: false; reason: string };

/** The same refusals the server makes, so a downgrade never reaches the wire. */
export function chooseEquipment(
  tank: Pick<Tank, 'biome' | 'equipment'>,
  economy: Economy,
  device: Device,
  tier: number,
): EquipmentChoice {
  const label = DEVICE_LABEL[device].toLowerCase();
  if (!devicesForBiome(tank.biome).includes(device)) {
    return { ok: false, reason: `A ${label} is not used in this kind of tank.` };
  }
  const price = economy.items.equipment[device][tier - 1];
  if (price === undefined) return { ok: false, reason: `There is no tier ${tier} ${label}.` };
  const current = tank.equipment[device].tier;
  if (tier === current)
    return { ok: false, reason: `This tank already has a tier ${tier} ${label}.` };
  if (tier < current) {
    return {
      ok: false,
      reason: `This tank has a tier ${current} ${label}; a lower tier would be a downgrade, which the shop does not sell.`,
    };
  }
  return { ok: true, ref: equipmentRef(device, tier), price, skipped: tier - current - 1 };
}
