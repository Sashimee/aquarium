import type { Biome, CreatableBiome } from '@aquarium/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { BUNDLED_ECONOMY } from '../sync/bundledEconomy';
import { earnedText, euroText, pearlText } from '../sync/economy';
import type { CameraMode } from '../interaction/camera';
import { chipState, type ChipStatus } from './chemistryChip';
import { useAuth, useBridge, useCameraMode, useDemoBiome } from './context';
import { getDip, subscribeDips } from './dipStore';
import { BookIcon, DuskIcon, MoonIcon, PersonIcon, SunIcon, TankIcon } from './icons';
import type { OpenPanel } from './panels';
import { Link } from './screens';
import { useActiveTank, useOptionalSession, useSessionState } from './session';
import { canSwitch, planSwitch, shownBiome } from './tankSwitch';
import { gaugeSummary, tankGauges, timeOfDay, type TimeOfDay } from './tankStatus';

const BIOME_LABEL: Record<Biome, string> = {
  freshwater: 'Freshwater',
  reef: 'Reef',
  cichlid: 'Cichlid',
  blackwater: 'Blackwater',
  mangrove: 'Mangrove',
};

const TANK_TYPES: readonly { biome: CreatableBiome; label: string }[] = [
  { biome: 'freshwater', label: 'Freshwater' },
  { biome: 'reef', label: 'Reef' },
];

function useTimeOfDay(): TimeOfDay | null {
  const { engine } = useBridge();
  const [value, setValue] = useState<TimeOfDay | null>(null);
  useEffect(
    () => engine.on('engine:daylight', ({ level }) => setValue(timeOfDay(level))),
    [engine],
  );
  return value;
}

const TIME_ICON: Record<TimeOfDay, () => React.JSX.Element> = {
  Day: SunIcon,
  'Dawn or dusk': DuskIcon,
  Night: MoonIcon,
};

export function StatusCard({ open, onPress }: { open: boolean; onPress(): void }) {
  const tank = useActiveTank();
  const { species } = useSessionState();
  const demo = useDemoBiome();
  const time = useTimeOfDay();
  const gauges = tank ? tankGauges(tank, species) : [];
  const title = tank ? tank.name : 'Demo tank';
  const subtitle = tank ? BIOME_LABEL[tank.biome] : `${BIOME_LABEL[demo]}, not saved`;
  const TimeIcon = time ? TIME_ICON[time] : null;
  const summary = gaugeSummary(gauges);
  return (
    <button
      type="button"
      className="status-card"
      data-opener="report"
      aria-expanded={open}
      aria-controls={open ? 'panel-report' : undefined}
      aria-label={`Tank report: ${title}, ${subtitle}${summary ? `, ${summary}` : ''}${time ? `, ${time.toLowerCase()}` : ''}`}
      onClick={onPress}
    >
      <span className="status-head">
        <strong>{title}</strong>
        {TimeIcon && time && (
          <span className="time" title={time}>
            <TimeIcon />
          </span>
        )}
      </span>
      <span className="status-sub">{subtitle}</span>
      {gauges.length > 0 && (
        <span className="gauges" aria-hidden="true">
          {gauges.map((g) => (
            <span key={g.key} className="gauge" data-tone={g.tone} title={g.label}>
              <span className="gauge-label">{g.label}</span>
              <span className="gauge-bar">
                <span style={{ width: `${Math.round(g.value * 100)}%` }} />
              </span>
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

const CHIP_ICON: Record<ChipStatus, string> = {
  none: '-',
  unread: '?',
  partial: '?',
  stale: '~',
  safe: 'OK',
  warning: '!',
  danger: '!!',
};

export function ChemistryChip({ open, onPress }: { open: boolean; onPress(): void }) {
  const tank = useActiveTank();
  const { species } = useSessionState();
  const dip = useSyncExternalStore(
    subscribeDips,
    () => (tank ? getDip(tank.id) : null),
    () => null,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (dip) setNow(Date.now());
  }, [dip]);
  if (!tank) return null;
  const state = chipState(tank, species, dip, now);
  return (
    <button
      type="button"
      className="chem-chip"
      data-status={state.status}
      aria-expanded={open}
      aria-controls={open ? 'panel-care' : undefined}
      aria-label={state.ariaLabel}
      onClick={onPress}
    >
      <span className="chem-verdict">
        <span className="chem-mark" aria-hidden="true">
          {CHIP_ICON[state.status]}
        </span>
        {state.verdict}
      </span>
      {state.values.length > 0 && (
        <span className="chem-values" aria-hidden="true">
          {state.values.map((v) => (
            <span key={v.key} data-chem={v.key}>
              {v.label} {v.text}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

const EARNED_SHOWN_MS = 8000;

export function PearlBalance({ open, onPress }: { open: boolean; onPress(): void }) {
  const { phase, balance, earned } = useSessionState();
  const session = useOptionalSession();
  useEffect(() => {
    if (earned === null || !session) return;
    const timer = setTimeout(() => session.dismissEarned(), EARNED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [earned, session]);
  if (phase !== 'ready') return null;
  const known = balance !== null;
  const spoken = known
    ? `${pearlText(balance)}, about ${euroText(balance, BUNDLED_ECONOMY)}. Open the shop`
    : 'Pearl balance not loaded yet. Open the shop';
  return (
    <>
      <button
        type="button"
        className="pearls"
        data-opener="shop"
        aria-expanded={open}
        aria-controls={open ? 'panel-shop' : undefined}
        aria-label={spoken}
        title={known ? `About ${euroText(balance, BUNDLED_ECONOMY)}` : undefined}
        onClick={onPress}
      >
        <span className="pearl-dot" aria-hidden="true" />
        <span>{known ? balance.toLocaleString('en') : '...'}</span>
        {earned !== null && (
          <span className="pearls-earned" aria-hidden="true">
            +{earned.toLocaleString('en')}
          </span>
        )}
      </button>
      <span role="status" className="sr-only">
        {earned === null ? '' : earnedText(earned)}
      </span>
    </>
  );
}

export function CameraControls() {
  const { interaction } = useBridge();
  const mode = useCameraMode();
  const request = (next: CameraMode) => interaction.emit('camera:request-mode', { mode: next });
  return (
    <div role="group" aria-label="Camera" className="segmented camera-controls">
      <button type="button" aria-pressed={mode === 'orbit'} onClick={() => request('orbit')}>
        Outside
      </button>
      <button type="button" aria-pressed={mode === 'dive'} onClick={() => request('dive')}>
        Dive
      </button>
      <button
        type="button"
        aria-pressed={mode === 'focus'}
        onClick={() => request(mode === 'focus' ? 'orbit' : 'focus')}
      >
        Follow
      </button>
    </div>
  );
}

export function TankTypeSwitch({ onCreate }: { onCreate(biome: CreatableBiome): void }) {
  const { interaction } = useBridge();
  const session = useOptionalSession();
  const state = useSessionState();
  const demo = useDemoBiome();
  const shown = shownBiome(state, demo);
  const enabled = canSwitch(state);
  const choose = (target: CreatableBiome) => {
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
    <div role="group" aria-label="Tank type" className="segmented tank-type">
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

export function RoundButton({
  panel,
  open,
  label,
  onPress,
  children,
  disabled,
}: {
  panel: OpenPanel;
  open: boolean;
  label: string;
  onPress(): void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="round"
      data-opener={panel}
      aria-label={label}
      aria-expanded={open}
      aria-controls={open ? `panel-${panel}` : undefined}
      disabled={disabled ?? false}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

export function TankButton({ open, onPress }: { open: boolean; onPress(): void }) {
  return (
    <RoundButton panel="tanks" open={open} label="My tank" onPress={onPress}>
      <TankIcon />
    </RoundButton>
  );
}

export function CollectionButton({ onPress }: { onPress(): void }) {
  return (
    <button
      type="button"
      className="round"
      data-opener="collection"
      aria-haspopup="dialog"
      aria-label="Collection book"
      onClick={onPress}
    >
      <BookIcon />
    </button>
  );
}

export function AvatarButton({ open, onPress }: { open: boolean; onPress(): void }) {
  const { user, status } = useAuth();
  const initial = user?.name.trim().charAt(0).toUpperCase();
  return (
    <RoundButton
      panel="account"
      open={open}
      label={user ? `Account, ${user.name}` : 'Account'}
      onPress={onPress}
      disabled={status === 'loading'}
    >
      {initial ? <span className="initial">{initial}</span> : <PersonIcon />}
    </RoundButton>
  );
}

export function AccountPanel({ onCollection }: { onCollection(): void }) {
  const { user, status, signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {status === 'loading' ? (
        <p role="status">Checking your sign-in.</p>
      ) : user ? (
        <nav aria-label="Account" className="account">
          <p className="account-name">{user.name}</p>
          <button type="button" aria-haspopup="dialog" onClick={onCollection}>
            Collection book
          </button>
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
      ) : (
        <nav aria-label="Account" className="account">
          <Link to="/sign-in">Sign in</Link>
          <Link to="/sign-up">Create account</Link>
        </nav>
      )}
      <nav aria-label="Community" className="account legal">
        <Link to="/gallery">Tank gallery</Link>
      </nav>
      <nav aria-label="Legal" className="account legal">
        <Link to="/privacy">Privacy</Link>
        <Link to="/credits">Credits</Link>
      </nav>
    </>
  );
}
