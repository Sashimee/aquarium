import { useState, useSyncExternalStore } from 'react';
import { installMode, installState, readEnvironment } from './install';

export function InstallCard() {
  useSyncExternalStore(installState.subscribe, installState.getVersion);
  const [declined, setDeclined] = useState(false);
  const mode = installMode(
    installState.wasInstalled ? { ...readEnvironment(), standalone: true } : readEnvironment(),
    installState.hasPrompt,
  );
  if (mode === 'none') return null;

  return (
    <section aria-labelledby="install-title" data-testid="install-card">
      <h2 id="install-title">Install the app</h2>
      {mode === 'installed' && <p role="status">Aquarium is installed on this device.</p>}
      {mode === 'prompt' && (
        <>
          <p>Add Aquarium to your home screen to open it full screen, like any other app.</p>
          <button
            type="button"
            onClick={() =>
              void installState.prompt().then((outcome) => setDeclined(outcome === 'dismissed'))
            }
          >
            Install Aquarium
          </button>
        </>
      )}
      {mode === 'ios-hint' && (
        <p>
          To install, tap the Share button in Safari, then choose{' '}
          <strong>Add to Home Screen</strong>.
        </p>
      )}
      <p role="status" className="hint">
        {declined ? 'No problem. You can install it later from this page.' : ''}
      </p>
    </section>
  );
}
