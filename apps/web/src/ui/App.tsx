import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { useAuth, useRedirect, useRoute } from './context';
import { Dock } from './Dock';
import {
  AccountPanel,
  AvatarButton,
  CameraControls,
  StatusCard,
  TankButton,
  TankTypeSwitch,
} from './Hud';
import { LifeStatus } from './LifeStatus';
import { LoadingScreen } from './LoadingScreen';
import { usePanels, type OpenPanel, type Panel } from './panels';
import { FeedPanel, FeedToast, PlayPanel, useFood } from './PlayControls';
import { navigate } from './router';
import { Sheet } from './Sheet';
import { useSessionState } from './session';
import {
  CreditsScreen,
  NotFoundScreen,
  PrivacyScreen,
  SessionsScreen,
  SettingsScreen,
  SignInScreen,
  SignUpScreen,
  VerifyEmailScreen,
} from './screens';

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

const DecorBody = lazy(() => import('./DecorPanel'));
const TankReportBody = lazy(() => import('./TankReport'));
const TanksPanel = lazy(() => import('./TankPanel').then((m) => ({ default: m.TanksPanel })));
const ShopPanel = lazy(() => import('./TankPanel').then((m) => ({ default: m.ShopPanel })));
const CarePanel = lazy(() => import('./TankPanel').then((m) => ({ default: m.CarePanel })));

const PANEL_TITLE: Record<OpenPanel, { label: string; title: string }> = {
  feed: { label: 'Feed the fish', title: 'Feed' },
  play: { label: 'Play with the fish', title: 'Play' },
  decor: { label: 'Decorate the tank', title: 'Decorate' },
  shop: { label: 'Fish shop', title: 'Fish shop' },
  care: { label: 'Care', title: 'Care' },
  tanks: { label: 'Your tank', title: 'Your tank' },
  report: { label: 'Tank report', title: 'Tank report' },
  account: { label: 'Account menu', title: 'Account' },
};

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

function PanelBody({
  panel,
  newTank,
  food,
  onFood,
}: {
  panel: OpenPanel;
  newTank: ReturnType<typeof usePanels>['newTank'];
  food: ReturnType<typeof useFood>[0];
  onFood: ReturnType<typeof useFood>[1];
}) {
  switch (panel) {
    case 'feed':
      return <FeedPanel food={food} onFood={onFood} />;
    case 'play':
      return <PlayPanel />;
    case 'decor':
      return <DecorBody />;
    case 'shop':
      return <ShopPanel />;
    case 'care':
      return <CarePanel />;
    case 'tanks':
      return <TanksPanel key={newTank ?? 'default'} newTankBiome={newTank} />;
    case 'report':
      return <TankReportBody />;
    case 'account':
      return <AccountPanel />;
  }
}

function isOpen(panel: Panel): panel is OpenPanel {
  return panel !== 'none';
}

export function App() {
  useRedirect();
  const route = useRoute();
  const home = route.name === 'home';
  const { panel: requested, newTank, dispatch } = usePanels();
  const panel: Panel = home ? requested : 'none';
  const [food, setFood] = useFood();
  const shell = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const previous = useRef(route.name);

  useLayoutEffect(() => {
    const target = dock.current;
    const root = shell.current;
    if (!target || !root) return;
    const publish = () => root.style.setProperty('--dock-h', `${target.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (home && previous.current !== 'home' && !document.querySelector('.sheet')) {
      document.getElementById('tank')?.focus();
    }
    previous.current = route.name;
    dispatch({ type: 'route-changed', home });
  }, [route.name, home, dispatch]);

  const closable = panel !== 'none' && panel !== 'decor';
  useEffect(() => {
    if (!closable) return;
    const canvas = document.getElementById('tank');
    if (!canvas) return;
    const close = () => dispatch({ type: 'close' });
    canvas.addEventListener('pointerdown', close);
    return () => canvas.removeEventListener('pointerdown', close);
  }, [closable, dispatch]);

  const toggle = (target: OpenPanel) => {
    if (home) return dispatch({ type: 'toggle', panel: target });
    navigate('/');
    dispatch({ type: 'open', panel: target });
  };

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
      <header className="hud">
        <div className="hud-left">
          <StatusCard open={panel === 'report'} onPress={() => toggle('report')} />
          <CameraControls />
        </div>
        <div className="hud-right">
          <div className="hud-buttons">
            <TankButton open={panel === 'tanks'} onPress={() => toggle('tanks')} />
            <AvatarButton open={panel === 'account'} onPress={() => toggle('account')} />
          </div>
          <TankTypeSwitch
            onCreate={(biome) => {
              if (!home) navigate('/');
              dispatch({ type: 'new-tank', biome });
            }}
          />
        </div>
      </header>
      <div className="toasts">
        <LifeStatus />
        <FeedToast />
      </div>
      {isOpen(panel) && (
        <Sheet
          key={panel}
          panel={panel}
          label={PANEL_TITLE[panel].label}
          title={PANEL_TITLE[panel].title}
          closeLabel={panel === 'decor' ? 'Done' : 'Close'}
          onClose={() => dispatch({ type: 'close' })}
        >
          <Suspense
            fallback={
              <p className="hint" role="status">
                Opening.
              </p>
            }
          >
            <PanelBody panel={panel} newTank={newTank} food={food} onFood={setFood} />
          </Suspense>
        </Sheet>
      )}
      <LifeDialogs onReview={() => dispatch({ type: 'open', panel: 'care' })} />
      <div className={home ? 'stage' : 'stage modal'}>
        <Screen />
      </div>
      <div className="dock-wrap" ref={dock}>
        <Dock panel={panel} onPress={toggle} />
      </div>
      {home && <LoadingScreen />}
    </div>
  );
}
