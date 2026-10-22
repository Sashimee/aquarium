import { useSyncExternalStore } from 'react';
import { displayPreference as shared, type DisplayPreference } from '../engine/displayPreference';

export function hasCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** Phones and tablets already draw every frame at full resolution, so the toggles do nothing there. */
export function DisplaySetting({
  preference = shared,
  coarsePointer = hasCoarsePointer(),
}: {
  preference?: DisplayPreference;
  coarsePointer?: boolean;
}) {
  const choice = useSyncExternalStore(
    preference.subscribe,
    preference.snapshot,
    preference.snapshot,
  );
  if (coarsePointer) return null;
  return (
    <section aria-labelledby="display-title">
      <h2 id="display-title">Display</h2>
      <label>
        <input
          type="checkbox"
          checked={choice.frameRate === 'display'}
          aria-describedby="display-note"
          onChange={(e) => preference.set({ frameRate: e.target.checked ? 'display' : 'capped' })}
        />{' '}
        Match display refresh rate
      </label>
      <br />
      <label>
        <input
          type="checkbox"
          checked={choice.pixelRatio === 'device'}
          aria-describedby="display-note"
          onChange={(e) => preference.set({ pixelRatio: e.target.checked ? 'device' : 'capped' })}
        />{' '}
        Full device resolution
      </label>
      <p id="display-note" className="hint">
        Smoother and sharper on a fast display, but uses more power and makes the GPU fans louder.
        Takes effect straight away.
      </p>
    </section>
  );
}
