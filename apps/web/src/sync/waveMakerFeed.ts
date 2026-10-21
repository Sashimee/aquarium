import type { FlowField } from '@aquarium/sim';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';

export interface WaveMakerSink {
  setWaveMakerTier(tier: number): void;
}

export interface PumpScene {
  setWaveMaker(field: FlowField | null, simTimeS: number): void;
  syncWaveMaker(simTimeS: number): void;
}

export interface PumpSource {
  /** The flow field for a tier in the tank now on show; null for no pump. */
  field(tier: number): FlowField | null;
  simTimeS(): number;
}

/**
 * Carries the active tank's wave maker tier to the sim. Created before the UI mounts, because the
 * session can load a tank before the fish are up; `attach` hands over the tier held so far.
 * Leaving a tank (switch, reset or no tank) removes the wave maker until the next tank says.
 */
export class WaveMakerFeed {
  private tier = 0;
  private sink: WaveMakerSink | null = null;
  private scene: PumpScene | null = null;
  private source: PumpSource | null = null;
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

  /** Hands the mounted scene the pump held so far; call again after a scene is rebuilt. */
  attachScene(scene: PumpScene, source: PumpSource): void {
    this.scene = scene;
    this.source = source;
    this.pushToScene();
  }

  detachScene(): void {
    this.scene = null;
    this.source = null;
  }

  /** Once per frame: the scene's pump follows the sim clock, not the render clock. */
  syncScene(): void {
    this.scene?.syncWaveMaker(this.source?.simTimeS() ?? 0);
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.sink = null;
    this.detachScene();
  }

  private set(tier: number): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.sink?.setWaveMakerTier(tier);
    this.pushToScene();
  }

  private pushToScene(): void {
    if (this.scene === null || this.source === null) return;
    this.scene.setWaveMaker(this.source.field(this.tier), this.source.simTimeS());
  }
}
