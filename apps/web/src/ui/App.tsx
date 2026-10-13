import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Biome } from '@aquarium/shared';
import type { CameraMode } from '../interaction/camera';
import {
  useAuth,
  useBridge,
  useCameraMode,
  useDecorState,
  useDemoBiome,
  useRedirect,
  useRoute,
} from './context';
import { usePanels } from './panels';
import { LifeStatus } from './LifeStatus';
import { PlayControls } from './PlayControls';
import { useOptionalSession, useSessionState } from './session';
import { canSwitch, planSwitch, shownBiome } from './tankSwitch';
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

const TANK_TYPES: readonly { biome: Biome; label: string }[] = [
  { biome: 'freshwater', label: 'Freshwater' },
  { biome: 'reef', label: 'Reef' },
];

function TankTypeSwitch({ onCreate }: { onCreate(biome: Biome): void }) {
  const { interaction } = useBridge();
  const session = useOptionalSession();
  const state = useSessionState();
  const demo = useDemoBiome();
  const shown = shownBiome(state, demo);
  const enabled = canSwitch(state);
  const choose = (target: Biome) => {
    const plan = planSwitch(state, demo, target);
    switch (plan.kind) {
      case 'none':
        return;
      case 'demo':
        interaction.emit('demo:request-biome', { biome: plan.biome });
        return;
      case 'select':
        void session?.select(plan.tankId);
        return;
      case 'create':
        onCreate(plan.biome);
        return;
    }
  };
  return (
    <div role="group" aria-label="Tank type" className="tank-type">
      {TANK_TYPES.map(({ biome, label }) => (
        <button
          key={biome}
          type="button"
          aria-pressed={shown === biome}
          disabled={!enabled}
          onClick={() => choose(biome)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function DecorToggle({ pressed, onToggle }: { pressed: boolean; onToggle(): void }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onToggle}>
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
    case 'forgot-password':
      return (
        <Suspense fallback={null}>
          <ForgotPasswordScreen />
        </Suspense>
      );
    case 'reset-password':
      return (
        <Suspense fallback={null}>
          <ResetPasswordScreen token={route.token} error={route.error} />
        </Suspense>
      );
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

const ForgotPasswordScreen = lazy(() =>
  import('./PasswordReset').then((m) => ({ default: m.ForgotPasswordScreen })),
);
const ResetPasswordScreen = lazy(() =>
  import('./PasswordReset').then((m) => ({ default: m.ResetPasswordScreen })),
);

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
  const { panel, dispatch } = usePanels();
  const panelOpen = panel === 'tank';
  const [newTankBiome, setNewTankBiome] = useState<Biome | null>(null);
  const decorating = panel === 'decor';
  const shell = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  const previous = useRef(route.name);
  useLayoutEffect(() => {
    const target = bar.current;
    const root = shell.current;
    if (!target || !root) return;
    const publish = () => root.style.setProperty('--bar-h', `${target.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (route.name === 'home' && previous.current !== 'home') {
      document.getElementById('tank')?.focus();
    }
    previous.current = route.name;
  }, [route.name]);
  return (
    <div className="shell" ref={shell}>
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
      <header className="bar" ref={bar}>
        <Link to="/" className="brand">
          Aquarium
        </Link>
        <TankTypeSwitch
          onCreate={(biome) => {
            setNewTankBiome(biome);
            dispatch({ type: 'open-tank' });
          }}
        />
        <CameraControls />
        {decorating ? null : <PlayControls />}
        <DecorToggle pressed={decorating} onToggle={() => dispatch({ type: 'toggle-decor' })} />
        <button
          type="button"
          aria-expanded={panelOpen}
          aria-controls="tank-panel"
          onClick={() => {
            setNewTankBiome(null);
            dispatch({ type: 'toggle-tank' });
          }}
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
          <TankPanel
            key={newTankBiome ?? 'default'}
            open
            newTankBiome={newTankBiome}
            onClose={() => dispatch({ type: 'close' })}
          />
        </Suspense>
      )}
      <DecorEditor />
      <LifeDialogs onReview={() => dispatch({ type: 'open-tank' })} />
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
