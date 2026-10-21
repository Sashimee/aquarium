import { useSyncExternalStore } from 'react';
import { roomPreference as shared } from '../interaction/roomPreference';
import { ROOM_CHOICES, type RoomChoice } from '../scene/room/layout';
import type { RoomPreference } from '../scene/room/preference';

export const ROOM_LABELS: Readonly<Record<RoomChoice, string>> = {
  none: 'No room',
  'living-room': 'Living room',
  office: 'Office',
};

export function RoomSetting({ preference = shared }: { preference?: RoomPreference }) {
  const choice = useSyncExternalStore(
    preference.subscribe,
    preference.snapshot,
    preference.snapshot,
  );
  return (
    <section aria-labelledby="room-title">
      <h2 id="room-title">Room</h2>
      <fieldset aria-describedby="room-note">
        <legend>Room around the tank</legend>
        {ROOM_CHOICES.map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="room"
              value={value}
              checked={choice === value}
              onChange={() => preference.set(value)}
            />{' '}
            {ROOM_LABELS[value]}
          </label>
        ))}
      </fieldset>
      <p id="room-note" className="hint">
        A room with a window shows the time of day and weather outside. The camera drifts around the
        tank when you leave it alone, unless your device asks for reduced motion.
      </p>
    </section>
  );
}
