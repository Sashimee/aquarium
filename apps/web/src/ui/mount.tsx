import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { haptics } from '../interaction/haptics';
import { watchReducedMotion } from '../interaction/motion';
import { App } from './App';
import { UiProviders, type UiBridge } from './context';
import { SessionProvider } from './session';
import './styles.css';
import './game.css';
import './loading.css';

/** Returns a function that unmounts the overlay. */
export function mountUi(container: HTMLElement, bridge: UiBridge): () => void {
  const stopHaptics = haptics.attach(bridge.interaction);
  const stopMotion = watchReducedMotion((reduced) => haptics.setReducedMotion(reduced));
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
    stopMotion();
    root.unmount();
  };
}
