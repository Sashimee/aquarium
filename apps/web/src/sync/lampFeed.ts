import { DEFAULT_LAMP_HOURS, type LampHours } from '../engine/daylight';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';

export interface LampSink {
  setLampSchedule(hours: LampHours): void;
}

/**
 * Carries the active tank's lamp hours (UTC, as the sim's `lampIsOn` reads them) to the hood light.
 * Created before the engine exists, so `attach` hands over the hours held so far. Leaving a tank
 * or having none returns the hood to the default schedule.
 */
export class LampFeed {
  private hours: LampHours = DEFAULT_LAMP_HOURS;
  private sink: LampSink | null = null;
  private activeTankId: string | null = null;
  private readonly unsubscribe: (() => void)[];

  constructor(interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId }) => {
        this.activeTankId = tankId;
        this.set(DEFAULT_LAMP_HOURS);
      }),
      interaction.on('tank:lamp', ({ tankId, onHour, offHour }) => {
        if (tankId === this.activeTankId) this.set({ onHour, offHour });
      }),
      interaction.on('tank:unloaded', () => this.reset()),
      interaction.on('tank:none', () => this.reset()),
    ];
  }

  attach(sink: LampSink): void {
    this.sink = sink;
    sink.setLampSchedule(this.hours);
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.sink = null;
  }

  private reset(): void {
    this.activeTankId = null;
    this.set(DEFAULT_LAMP_HOURS);
  }

  private set(hours: LampHours): void {
    if (hours.onHour === this.hours.onHour && hours.offHour === this.hours.offHour) return;
    this.hours = hours;
    this.sink?.setLampSchedule(hours);
  }
}
