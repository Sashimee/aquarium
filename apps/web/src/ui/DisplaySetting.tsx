import { useSyncExternalStore } from 'react';
import {
  displayPreference as shared,
  hasCoarsePointer,
  urlDisplayOverrides,
  type DisplayChoice,
  type DisplayPreference,
} from '../engine/displayPreference';

/** Phones and tablets already draw every frame at full resolution, so the toggles do nothing there. */
export function DisplaySetting({
  preference = shared,
  coarsePointer = hasCoarsePointer(),
  overrides = urlDisplayOverrides(window.location.search),
}: {
  preference?: DisplayPreference;
  coarsePointer?: boolean;
  overrides?: Partial<DisplayChoice>;
}) {
  const stored = useSyncExternalStore(
    preference.subscribe,
    preference.snapshot,
    preference.snapshot,
  );
  if (coarsePointer) return null;
  const choice = { ...stored, ...overrides };
  const forcedFrameRate = overrides.frameRate !== undefined;
  const forcedPixelRatio = overrides.pixelRatio !== undefined;
  return (
    <section aria-labelledby="display-title">
      <h2 id="display-title">Display</h2>
      <fieldset aria-describedby="display-note">
        <legend>Frame rate and resolution</legend>
        <label>
          <input
            type="checkbox"
            checked={choice.frameRate === 'display'}
            disabled={forcedFrameRate}
            onChange={(e) => preference.set({ frameRate: e.target.checked ? 'display' : 'capped' })}
          />{' '}
          Match display refresh rate
        </label>
        <label>
          <input
            type="checkbox"
            checked={choice.pixelRatio === 'device'}
            disabled={forcedPixelRatio}
            onChange={(e) => preference.set({ pixelRatio: e.target.checked ? 'device' : 'capped' })}
          />{' '}
          Full device resolution
        </label>
      </fieldset>
      <p id="display-note" className="hint">
        Smoother and sharper on a fast display, but uses more power and makes the GPU fans louder.
        Takes effect straight away.
        {(forcedFrameRate || forcedPixelRatio) &&
          ' A greyed-out setting is fixed by the address of this page (fps or dpr).'}
      </p>
    </section>
  );
}
