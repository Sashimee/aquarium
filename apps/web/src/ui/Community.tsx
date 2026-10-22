import { COMMUNITY_FEED_PORTION_MIN, foodTypeSchema, type CommunityQuota } from '@aquarium/shared';
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import {
  applyTankToScene,
  CommunityController,
  INITIAL_COMMUNITY_STATE,
  quotaText,
  secondsLeft,
  waitText,
  type CommunityViewState,
} from '../sync/community';
import { createOpenStream } from '../sync/communityStream';
import { bundledCommonName } from '../sync/bundledSpecies';
import { useApi, useAuth, useBridge } from './context';
import { CameraControls } from './Hud';
import { FOOD_LABEL, useEngineReadyForPlay, useFood } from './PlayControls';
import { leaveToViewerSignIn } from './router';

const COMMUNITY_PATH = '/community';
const PORTION_CHOICES = [
  { portion: 0.1, label: 'A pinch' },
  { portion: 0.25, label: 'A little' },
  { portion: 0.5, label: 'Half' },
  { portion: 1, label: 'A full portion' },
] as const;

const noopSubscribe = () => () => undefined;

function useCommunity(): { controller: CommunityController | null; state: CommunityViewState } {
  const api = useApi();
  const { interaction } = useBridge();
  const { status, user } = useAuth();
  const [controller, setController] = useState<CommunityController | null>(null);
  const userKey = user ? `${user.id}:${user.emailVerified}` : '';

  useEffect(() => {
    if (status === 'loading') return;
    let shownId: string | null = null;
    const created = new CommunityController({
      api,
      openStream: createOpenStream(),
      onTank: (held, next) => {
        applyTankToScene(interaction, held, next);
        shownId = next.id;
      },
      onDrop: (food, portion) => interaction.emit('feed:request', { food, portion }),
    });
    const offAte = interaction.on('food:ate', ({ eaten }) => created.reportAte(eaten));
    created.start();
    setController(created);
    return () => {
      offAte();
      created.dispose();
      setController(null);
      if (shownId !== null) interaction.emit('tank:unloaded', { tankId: shownId, reason: 'reset' });
    };
  }, [api, interaction, status, userKey]);

  const state = useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getState : () => INITIAL_COMMUNITY_STATE,
  );

  const unreachable = state.tank === null && state.connection === 'reconnecting';
  useEffect(() => {
    if (unreachable) interaction.emit('tank:none', {});
  }, [unreachable, interaction]);

  return { controller, state };
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function portionChoices(
  quota: CommunityQuota | null,
  tankFeedRemaining: number | null,
): readonly (typeof PORTION_CHOICES)[number][] {
  const room = Math.min(quota?.remaining ?? 0, tankFeedRemaining ?? Infinity);
  return PORTION_CHOICES.filter((c) => c.portion <= room + 1e-9);
}

function ConnectionNote({ state, now }: { state: CommunityViewState; now: number }) {
  const wait = secondsLeft(state.reconnectAt, now);
  let text = '';
  if (state.connection === 'connecting')
    text = state.tank ? 'Reconnecting.' : 'Opening the community tank.';
  if (state.connection === 'reconnecting') {
    text = `${state.streamProblem ?? 'The live connection was lost.'} Reconnecting${wait > 0 ? ` in ${waitText(wait)}` : ''}.`;
  }
  return (
    <p role="status" className="hint community-connection">
      {text}
    </p>
  );
}

function SignInPrompt() {
  const go = (destination: string) => (e: React.MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    leaveToViewerSignIn(COMMUNITY_PATH, destination);
  };
  return (
    <p className="hint">
      You are watching.{' '}
      <a href="/sign-in" onClick={go('/sign-in')}>
        Sign in
      </a>{' '}
      or{' '}
      <a href="/sign-up" onClick={go('/sign-up')}>
        create an account
      </a>{' '}
      to feed the fish.
    </p>
  );
}

function FeedBox({
  controller,
  state,
  now,
}: {
  controller: CommunityController | null;
  state: CommunityViewState;
  now: number;
}) {
  const { status, user } = useAuth();
  const [food, setFood] = useFood();
  const [portion, setPortion] = useState<number>(0.25);
  const ready = useEngineReadyForPlay();
  const foodId = useId();
  const portionId = useId();
  const allowance = quotaText(state.quota, state.tankFeedRemaining);
  const choices = portionChoices(state.quota, state.tankFeedRemaining);
  const chosen = choices.find((c) => c.portion === portion) ?? choices.at(-1) ?? null;
  const wait = secondsLeft(state.problem?.retryAt ?? null, now);

  if (status === 'loading') return null;
  if (!user) return <SignInPrompt />;
  if (!user.emailVerified) {
    return <p className="hint">Verify your email address to feed the community tank.</p>;
  }

  const blocked = wait > 0 || state.feeding || !ready || !controller || chosen === null;
  return (
    <div className="feed-controls community-feed-controls">
      <label htmlFor={foodId}>Food</label>
      <select
        id={foodId}
        value={food}
        onChange={(e) => setFood(foodTypeSchema.parse(e.target.value))}
      >
        {foodTypeSchema.options.map((f) => (
          <option key={f} value={f}>
            {FOOD_LABEL[f]}
          </option>
        ))}
      </select>
      <label htmlFor={portionId}>Amount</label>
      <select
        id={portionId}
        value={chosen?.portion ?? ''}
        disabled={choices.length === 0}
        onChange={(e) => setPortion(Number(e.target.value))}
      >
        {choices.map((c) => (
          <option key={c.portion} value={c.portion}>
            {c.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="primary big"
        disabled={blocked}
        onClick={() => chosen && void controller?.feed(food, chosen.portion)}
      >
        {wait > 0 ? `Wait ${waitText(wait)}` : 'Drop food'}
      </button>
      <p className="hint">
        {allowance.mine}
        {choices.length === 0 &&
        state.quota !== null &&
        state.quota.remaining >= COMMUNITY_FEED_PORTION_MIN
          ? ' The tank cannot take more food right now.'
          : ''}
      </p>
      <p role="status" className="hint community-feed-note">
        {state.problem
          ? `${state.problem.text}${wait > 0 ? ` Try again in ${waitText(wait)}.` : ''}`
          : state.notice}
      </p>
      {state.problem?.needs === 'verify' && (
        <p className="hint">Check your inbox for the verification link.</p>
      )}
    </div>
  );
}

function Report({ state }: { state: CommunityViewState }) {
  const id = useId();
  const { tank } = state;
  if (!tank) return null;
  const living = tank.fish.filter((f) => f.status === 'alive');
  return (
    <details className="public-report">
      <summary id={id}>Tank report</summary>
      <div aria-labelledby={id}>
        <p>
          {living.length === 0
            ? 'No fish are alive in the community tank.'
            : `${living.length} fish alive: ${living
                .map((f) => `${f.name} the ${bundledCommonName(f.species)}`)
                .join('; ')}.`}
        </p>
        <p>{quotaText(null, state.tankFeedRemaining).tank}</p>
      </div>
    </details>
  );
}

function Happenings({ state }: { state: CommunityViewState }) {
  const headingId = useId();
  return (
    <section className="community-happenings" aria-labelledby={headingId}>
      <h2 id={headingId}>Happening now</h2>
      {state.lines.length === 0 ? (
        <p className="hint">Nothing yet. Feedings, births and losses show up here.</p>
      ) : (
        <ol>
          {state.lines.map((line) => (
            <li key={line.id}>{line.text}</li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function CommunityView() {
  const { controller, state } = useCommunity();
  const ticking = state.reconnectAt !== null || state.problem?.retryAt != null;
  const now = useNow(ticking);
  const title = 'Community tank';
  useEffect(() => {
    const before = document.title;
    document.title = `${title}, a shared tank`;
    return () => {
      document.title = before;
    };
  }, []);
  const viewers = useMemo(
    () => `${state.viewers} ${state.viewers === 1 ? 'person' : 'people'} watching`,
    [state.viewers],
  );

  return (
    <main className="public-bar community-bar">
      <div className="public-title">
        <h1>{title}</h1>
        <p className="hint">
          One tank for everyone. You can watch and feed; the care is done for you.
        </p>
        <p className="hint community-viewers">{state.connection === 'live' ? viewers : ''}</p>
      </div>
      <ConnectionNote state={state} now={now} />
      <div className="community-panel">
        <FeedBox controller={controller} state={state} now={now} />
        <p className="hint">{quotaText(null, state.tankFeedRemaining).tank}</p>
      </div>
      <Happenings state={state} />
      <CameraControls />
      <Report state={state} />
      <a className="public-own" href="/">
        Back to my tank
      </a>
    </main>
  );
}
