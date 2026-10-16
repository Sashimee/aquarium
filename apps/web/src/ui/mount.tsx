import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { UiProviders, type UiBridge } from './context';
import { startPwa } from './pwa/register';
import { SessionProvider } from './session';
import './styles.css';
import './game.css';
import './loading.css';

/** Returns a function that unmounts the overlay. */
export function mountUi(container: HTMLElement, bridge: UiBridge): () => void {
  startPwa();
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
  return () => root.unmount();
}
