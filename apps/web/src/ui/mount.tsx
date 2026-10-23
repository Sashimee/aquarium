import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { audio } from '../interaction/audio/engine';
import { haptics } from '../interaction/haptics';
import { bindRoomAmbience } from '../interaction/roomAmbience';
import { watchReducedMotion } from '../interaction/motion';
import { App } from './App';
import { UiProviders, type UiBridge } from './context';
import { startPwa } from '../pwa/register';
import { SessionProvider } from './session';
import { watchStalePreloads } from './staleBuild';
import './styles.css';
import './game.css';
import './photo.css';
import './loading.css';

/** Returns a function that unmounts the overlay. */
export function mountUi(container: HTMLElement, bridge: UiBridge): () => void {
  const stopHaptics = haptics.attach(bridge.interaction);
  const stopMotion = watchReducedMotion((reduced) => haptics.setReducedMotion(reduced));
  const stopAudioBus = audio.attach(bridge.interaction);
  const stopAudio = audio.start();
  const stopAmbience = bindRoomAmbience(bridge.interaction, audio);
  startPwa();
  const stopStale = watchStalePreloads();
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <UiProviders bridge={bridge}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </UiProviders>
    </StrictMode>,
  );
  return () => {
    stopHaptics();
    stopAudioBus();
    stopAmbience();
    stopAudio();
    stopMotion();
    stopStale();
    root.unmount();
  };
}
