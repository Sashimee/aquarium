import { z } from 'zod';

export const tankSizeSchema = z.enum(['nano30', 'standard', 'std200', 'long300']);
export type TankSize = z.infer<typeof tankSizeSchema>;

export const DEFAULT_TANK_SIZE: TankSize = 'standard';

export interface TankSizeSpec {
  readonly litres: number;
  /** Outer size in metres, the frame of tankSpace.ts. */
  readonly dimensions: {
    readonly length: number;
    readonly depth: number;
    readonly height: number;
    readonly glass: number;
    /** Gap from the water surface to the glass rim. */
    readonly freeboard: number;
  };
  /** Fish, fry and invertebrates together. */
  readonly maxAnimals: number;
}

export const TANK_SIZES: Readonly<Record<TankSize, TankSizeSpec>> = {
  nano30: {
    litres: 30,
    dimensions: { length: 0.4, depth: 0.25, height: 0.3, glass: 0.005, freeboard: 0.02 },
    maxAnimals: 12,
  },
  standard: {
    litres: 300,
    dimensions: { length: 1.2, depth: 0.5, height: 0.5, glass: 0.01, freeboard: 0.03 },
    maxAnimals: 60,
  },
  std200: {
    litres: 200,
    dimensions: { length: 1, depth: 0.4, height: 0.5, glass: 0.008, freeboard: 0.03 },
    maxAnimals: 60,
  },
  long300: {
    litres: 300,
    dimensions: { length: 1.5, depth: 0.45, height: 0.45, glass: 0.01, freeboard: 0.03 },
    maxAnimals: 60,
  },
};

export const MAX_DISPLAY_TANKS = 6;
export const MAX_QUARANTINE_TANKS = 1;
export const QUARANTINE_TANK_SIZE: TankSize = 'nano30';
