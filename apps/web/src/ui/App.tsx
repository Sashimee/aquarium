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
import { PlayControls } from './PlayControls';
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
        <p>A 300 litre freshwater aquarium, 120 by 50 by 50 centimetres.</p>
        <p>Camera: {MODE_LABEL[mode]}.</p>
        <p>
          {engine
            ? `Rendering with ${engine.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} at the ${engine.tier} quality tier.`
            : 'The tank is still loading.'}
        </p>
        <p>No fish live here yet.</p>
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
        <AccountMenu />
      </header>
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
