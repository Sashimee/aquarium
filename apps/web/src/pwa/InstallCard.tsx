import { useSyncExternalStore } from 'react';
import {
  installMode,
  installState,
  readEnvironment,
  type Environment,
  type InstallState,
} from './install';

interface Props {
  state?: InstallState;
  environment?: Environment;
}

export function InstallCard({ state = installState, environment }: Props) {
  useSyncExternalStore(state.subscribe, state.getVersion, state.getVersion);
  const env = environment ?? readEnvironment();
  const mode = installMode(
    state.wasInstalled ? { ...env, standalone: true } : env,
    state.hasPrompt,
  );
  if (mode === 'none') return null;
  const { phase } = state;

  return (
    <section aria-labelledby="install-title" data-testid="install-card">
      <h2 id="install-title">Install the app</h2>
      {mode === 'installed' && <p role="status">Aquarium is installed on this device.</p>}
      {mode === 'prompt' && (
        <>
          <p>Add Aquarium to your home screen to open it full screen, like any other app.</p>
          {(phase === 'idle' || phase === 'asking') && (
            <button type="button" disabled={phase === 'asking'} onClick={() => void state.prompt()}>
              {phase === 'asking' ? 'Waiting for your browser…' : 'Install Aquarium'}
            </button>
          )}
          <p role="status" className="hint">
            {phase === 'accepted' && 'Installing…'}
            {phase === 'dismissed' &&
              'Installation was cancelled. Reload the page if you change your mind.'}
            {phase === 'failed' &&
              'Your browser could not start the install. Use its menu to add Aquarium to your home screen.'}
          </p>
        </>
      )}
      {mode === 'ios-hint' && (
        <p>
          To install, tap the Share button in Safari, then choose{' '}
          <strong>Add to Home Screen</strong>.
        </p>
      )}
    </section>
  );
}
