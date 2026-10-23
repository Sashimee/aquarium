import { DEFAULT_LAMP_SCHEDULE, type LampSchedule } from '../engine/daylight';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';

export interface LampSink {
  setLampSchedule(schedule: LampSchedule): void;
}

/**
 * Carries the active tank's lamp hours (UTC, as the sim's `lampIsOn` reads them) and strength to
 * the hood light.
 * Created before the engine exists, so `attach` hands over the hours held so far. Signing out or
 * having no tank returns the hood to the default schedule; a tank switch keeps the old hours until
 * the next tank announces its own, so the hood never shows a default period in between.
 */
export class LampFeed {
  private schedule: LampSchedule = DEFAULT_LAMP_SCHEDULE;
  private sink: LampSink | null = null;
  private activeTankId: string | null = null;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId }) => {
        this.activeTankId = tankId;
      }),
      interaction.on('tank:lamp', ({ tankId, intensity, onHour, offHour }) => {
        if (tankId === this.activeTankId) this.set({ intensity, onHour, offHour });
      }),
      interaction.on('tank:unloaded', ({ reason }) => {
        if (reason === 'reset') this.reset();
        else this.activeTankId = null;
      }),
      interaction.on('tank:none', () => this.reset()),
    ];
  }

  attach(sink: LampSink): void {
    this.sink = sink;
    sink.setLampSchedule(this.schedule);
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.sink = null;
  }

  private reset(): void {
    this.activeTankId = null;
    this.set(DEFAULT_LAMP_SCHEDULE);
  }

  private set(schedule: LampSchedule): void {
    const held = this.schedule;
    if (
      schedule.intensity === held.intensity &&
      schedule.onHour === held.onHour &&
      schedule.offHour === held.offHour
    )
      return;
    this.schedule = schedule;
    this.sink?.setLampSchedule(schedule);
    this.interaction.emit('lamp:schedule', schedule);
  }
}
