import { useEffect, useRef, useState } from 'react';
import type { CameraMode } from '../interaction/camera';
import {
  useAuth,
  useBridge,
  useCameraMode,
  useEngineReady,
  useRedirect,
  useRoute,
} from './context';
import { tankReportLines } from '../sync/life';
import { AwayDialog, LifeStatus } from './LifeStatus';
import { PlayControls } from './PlayControls';
import { useActiveTank, useSessionState } from './session';
import { TankPanel } from './TankPanel';
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

const MODE_LABEL: Record<CameraMode, string> = {
  orbit: 'Outside view',
  focus: 'Following a fish',
  dive: 'Inside the tank',
};

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

function TankReport() {
  const [open, setOpen] = useState(false);
  const engine = useEngineReady();
  const mode = useCameraMode();
  const tank = useActiveTank();
  const { species, phase } = useSessionState();
  return (
    <section className="report" aria-label="Tank report">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="tank-report-body"
        onClick={() => setOpen(!open)}
      >
        Tank report
      </button>
      <div id="tank-report-body" hidden={!open}>
        {tank ? (
          tankReportLines(tank, species).map((line) => <p key={line}>{line}</p>)
        ) : (
          <>
            <p>A 300 litre freshwater aquarium, 120 by 50 by 50 centimetres.</p>
            <p>
              {phase === 'unverified'
                ? 'Verify your email address to keep a saved tank.'
                : 'This is the demo tank. Sign in with a verified account to keep a tank.'}
            </p>
          </>
        )}
        <p>Camera: {MODE_LABEL[mode]}.</p>
        <p>
          {engine
            ? `Rendering with ${engine.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} at the ${engine.tier} quality tier.`
            : 'The tank is still loading.'}
        </p>
      </div>
    </section>
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

export function App() {
  useRedirect();
  const route = useRoute();
  const modal = route.name !== 'home';
  const [panelOpen, setPanelOpen] = useState(false);
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
        <PlayControls />
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
      <TankPanel open={panelOpen} onClose={() => setPanelOpen(false)} />
      <AwayDialog onReview={() => setPanelOpen(true)} />
      <div className={modal ? 'stage modal' : 'stage'}>
        <Screen />
      </div>
      <TankReport />
      <footer className="legal-links">
        <nav aria-label="Legal">
          <Link to="/privacy">Privacy</Link>
          <Link to="/credits">Credits</Link>
        </nav>
      </footer>
    </div>
  );
}
