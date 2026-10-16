import { useSyncExternalStore } from 'react';
import { haptics as shared, type Haptics } from '../interaction/haptics';

export function HapticsSetting({ haptics = shared }: { haptics?: Haptics }) {
  useSyncExternalStore(haptics.subscribe, haptics.getVersion, haptics.getVersion);
  const note = !haptics.supported
    ? 'This device or browser does not support vibration, so there is nothing to turn on.'
    : haptics.reducedMotion
      ? 'Paused because your device asks for reduced motion.'
      : 'A short buzz when you tap the glass, drop food or net a fish.';
  return (
    <section aria-labelledby="haptics-title">
      <h2 id="haptics-title">Vibration</h2>
      <label>
        <input
          type="checkbox"
          checked={haptics.enabled && haptics.supported}
          disabled={!haptics.supported}
          aria-describedby="haptics-note"
          onChange={(e) => haptics.setEnabled(e.target.checked)}
        />{' '}
        Haptic feedback
      </label>
      <p id="haptics-note" className="hint">
        {note}
      </p>
    </section>
  );
}
