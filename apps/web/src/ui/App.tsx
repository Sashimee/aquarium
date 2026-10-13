import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { CameraMode } from '../interaction/camera';
import { useAuth, useBridge, useCameraMode, useDecorState, useRedirect, useRoute } from './context';
import { LifeStatus } from './LifeStatus';
import { PlayControls } from './PlayControls';
import { useSessionState } from './session';
import {
  CreditsScreen,
  Link,
  NotFoundScreen,
  PrivacyScreen,
  SessionsScreen,
  SettingsScreen,
  SignInScreen,
  SignUpScreen,
  VerifyEmailScreen,
} from './screens';

function CameraControls() {
  const { interaction } = useBridge();
  const mode = useCameraMode();
  const request = (next: CameraMode) => interaction.emit('camera:request-mode', { mode: next });
  return (
    <div role="group" aria-label="Camera" className="camera-controls">
      <button type="button" aria-pressed={mode === 'orbit'} onClick={() => request('orbit')}>
        Outside
      </button>
      <button type="button" aria-pressed={mode === 'dive'} onClick={() => request('dive')}>
        Dive
      </button>
    </div>
  );
}

function DecorToggle() {
  const { interaction } = useBridge();
  const active = useDecorState()?.active ?? false;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => interaction.emit('decor:request-mode', { active: !active })}
    >
      Decorate
    </button>
  );
}

const DecorPanel = lazy(() => import('./DecorPanel'));

function DecorEditor() {
  const active = useDecorState()?.active ?? false;
  if (!active) return null;
  return (
    <Suspense fallback={null}>
      <DecorPanel />
    </Suspense>
  );
}

function AccountMenu() {
  const { user, status, signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);
  if (status === 'loading') return null;
  if (!user) {
    return (
      <nav aria-label="Account" className="account">
        <Link to="/sign-in">Sign in</Link>
        <Link to="/sign-up">Create account</Link>
      </nav>
    );
  }
  return (
    <nav aria-label="Account" className="account">
      <span>{user.name}</span>
      <Link to="/sessions">Sessions</Link>
      <Link to="/settings">Settings</Link>
      <button
        type="button"
        onClick={() => {
          setError(null);
          signOut().catch((cause: unknown) => {
            console.error(cause);
            setError('Sign out failed. Try again.');
          });
        }}
      >
        Sign out
      </button>
      <span role="alert" hidden={!error}>
        {error}
      </span>
    </nav>
  );
}

function Screen() {
  const route = useRoute();
  const { status } = useAuth();

  switch (route.name) {
    case 'home':
      return null;
    case 'sign-in':
      return <SignInScreen />;
    case 'sign-up':
      return <SignUpScreen />;
    case 'verify-email':
      return <VerifyEmailScreen error={route.error} />;
    case 'sessions':
      return status === 'loading' ? null : <SessionsScreen />;
    case 'settings':
      return status === 'loading' ? null : <SettingsScreen />;
    case 'privacy':
      return <PrivacyScreen />;
    case 'credits':
      return <CreditsScreen />;
    case 'not-found':
      return <NotFoundScreen />;
  }
}

const TankReport = lazy(() => import('./TankReport'));
const TankPanel = lazy(() => import('./TankPanel').then((m) => ({ default: m.TankPanel })));

const LifeDialogsView = lazy(() => import('./LifeDialogs'));

function LifeDialogs({ onReview }: { onReview(): void }) {
  const state = useSessionState();
  if (!state.activeId || (!state.awayByTank[state.activeId] && !state.pendingNet)) return null;
  return (
    <Suspense fallback={null}>
      <LifeDialogsView onReview={onReview} />
    </Suspense>
  );
}

export function App() {
  useRedirect();
  const route = useRoute();
  const modal = route.name !== 'home';
  const [panelOpen, setPanelOpen] = useState(false);
  const decorating = useDecorState()?.active ?? false;
  const previous = useRef(route.name);
  useEffect(() => {
    if (route.name === 'home' && previous.current !== 'home') {
      document.getElementById('tank')?.focus();
    }
    previous.current = route.name;
  }, [route.name]);
  return (
    <div className="shell">
      <a
        className="skip"
        href="#tank"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('tank')?.focus();
        }}
      >
        Skip to the tank
      </a>
      <header className="bar">
        <Link to="/" className="brand">
          Aquarium
        </Link>
        <CameraControls />
        {decorating ? null : <PlayControls />}
        <DecorToggle />
        <button
          type="button"
          aria-expanded={panelOpen}
          aria-controls="tank-panel"
          onClick={() => setPanelOpen(!panelOpen)}
        >
          My tank
        </button>
        <AccountMenu />
      </header>
      <LifeStatus />
      {panelOpen && (
        <Suspense
          fallback={
            <p className="hint" role="status">
              Opening your tank...
            </p>
          }
        >
          <TankPanel open onClose={() => setPanelOpen(false)} />
        </Suspense>
      )}
      <DecorEditor />
      <LifeDialogs onReview={() => setPanelOpen(true)} />
      <div className={modal ? 'stage modal' : 'stage'}>
        <Screen />
      </div>
      <Suspense fallback={null}>
        <TankReport />
      </Suspense>
      <footer className="legal-links">
        <nav aria-label="Legal">
          <Link to="/privacy">Privacy</Link>
          <Link to="/credits">Credits</Link>
        </nav>
      </footer>
    </div>
  );
}
