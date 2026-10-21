import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';

export interface WaveMakerSink {
  setWaveMakerTier(tier: number): void;
}

/**
 * Carries the active tank's wave maker tier to the sim. Created before the UI mounts, because the
 * session can load a tank before the fish are up; `attach` hands over the tier held so far.
 * Leaving a tank (switch, reset or no tank) removes the wave maker until the next tank says.
 */
export class WaveMakerFeed {
  private tier = 0;
  private sink: WaveMakerSink | null = null;
  private activeTankId: string | null = null;
  private readonly unsubscribe: (() => void)[];

  constructor(interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId }) => {
        this.activeTankId = tankId;
        this.set(0);
      }),
      interaction.on('tank:wave-maker', ({ tankId, tier }) => {
        if (tankId === this.activeTankId) this.set(tier);
      }),
      interaction.on('tank:unloaded', () => {
        this.activeTankId = null;
        this.set(0);
      }),
      interaction.on('tank:none', () => {
        this.activeTankId = null;
        this.set(0);
      }),
    ];
  }

  attach(sink: WaveMakerSink): void {
    this.sink = sink;
    sink.setWaveMakerTier(this.tier);
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.sink = null;
  }

  private set(tier: number): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.sink?.setWaveMakerTier(tier);
  }
}
