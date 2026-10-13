import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { UiProviders, type UiBridge } from './context';
import { SessionProvider } from './session';
import './styles.css';

/** Returns a function that unmounts the overlay. */
export function mountUi(container: HTMLElement, bridge: UiBridge): () => void {
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
