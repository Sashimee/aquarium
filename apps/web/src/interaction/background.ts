import {
  DEFAULT_BACKGROUND_ID,
  isBackgroundForBiome,
  isPlayableBiome,
  type BackgroundId,
  type Biome,
} from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';

/** The picture a tank shows, the player's pick or the biome's default; null for a biome without any. */
export function shownBackground(biome: Biome, id: string | null): BackgroundId | null {
  if (id !== null && isBackgroundForBiome(biome, id)) return id;
  return isPlayableBiome(biome) ? DEFAULT_BACKGROUND_ID[biome] : null;
}

/**
 * Keeps which background is on show: the saved tank's, or a throwaway pick on the demo tank.
 * A pick on a saved tank is asked to be saved; the server's own changes come back as
 * `tank:background`.
 */
export class BackgroundChoice {
  private tankId: string | null = null;
  private biome: Biome;
  private demoBiome: Biome;
  private id: BackgroundId | null;
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly interaction: EventBus<InteractionEvents>,
    demoBiome: Biome,
  ) {
    this.biome = this.demoBiome = demoBiome;
    this.id = shownBackground(demoBiome, null);
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId, biome, backgroundId }) => {
        this.show(tankId, biome, backgroundId);
      }),
      interaction.on('tank:background', ({ tankId, backgroundId }) => {
        if (tankId === this.tankId) this.show(tankId, this.biome, backgroundId);
      }),
      interaction.on('tank:none', () => this.show(null, this.demoBiome, null)),
      interaction.on('demo:biome-changed', ({ biome }) => {
        this.demoBiome = biome;
        if (this.tankId === null) this.show(null, biome, null);
      }),
      interaction.on('background:choose', ({ backgroundId }) => this.choose(backgroundId)),
    ];
    this.emit();
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  private choose(backgroundId: BackgroundId): void {
    if (!isBackgroundForBiome(this.biome, backgroundId) || backgroundId === this.id) return;
    this.id = backgroundId;
    this.emit();
    if (this.tankId !== null) {
      this.interaction.emit('background:save', { tankId: this.tankId, backgroundId });
    }
  }

  private show(tankId: string | null, biome: Biome, id: string | null): void {
    this.tankId = tankId;
    this.biome = biome;
    this.id = shownBackground(biome, id);
    this.emit();
  }

  private emit(): void {
    this.interaction.emit('background:state', {
      tankId: this.tankId,
      biome: this.biome,
      backgroundId: this.id,
    });
  }
}
