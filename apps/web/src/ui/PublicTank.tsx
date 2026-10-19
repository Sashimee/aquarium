import { REACTION_KINDS, type PublicTank, type ReactionKind } from '@aquarium/shared';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  publicPath,
  MISSING_MESSAGE,
  publicReportLines,
  publicTankId,
  publicTankLoaded,
  reactionButtonName,
  reactionProblem,
  reactionProblemText,
  reactionTarget,
  slowDownMessage,
  viewerFailure,
  type ReactionProblem,
  type ViewerPhase,
} from '../sync/share';
import { useApi, useAuth, useBridge } from './context';
import { CameraControls } from './Hud';
import { leaveToViewerSignIn } from './router';

const GLYPH: Record<ReactionKind, string> = { heart: '♥', star: '★', wow: '!' };

function useNoIndex(title: string | null): void {
  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => {
      robots.remove();
      referrer.remove();
    };
  }, []);
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = `${title}, a shared tank`;
    return () => {
      document.title = before;
    };
  }, [title]);
}

function useViewer(token: string): {
  phase: ViewerPhase;
  setTank(tank: PublicTank): void;
  retry(): void;
} {
  const api = useApi();
  const { interaction } = useBridge();
  const { status, user } = useAuth();
  const [phase, setPhase] = useState<ViewerPhase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const shown = useRef<string | null>(null);
  const userKey = user?.id ?? '';

  useEffect(() => {
    if (status === 'loading') return;
    let cancelled = false;
    api.publicTank(token).then(
      (tank) => {
        if (cancelled) return;
        setPhase({ kind: 'ready', tank });
        if (shown.current !== null) return;
        shown.current = publicTankId(tank);
        interaction.emit('tank:loaded', publicTankLoaded(tank));
        interaction.emit('tank:water', { tankId: shown.current, water: tank.water });
      },
      (error: unknown) => {
        if (cancelled) return;
        setPhase((held) => (held.kind === 'ready' ? held : viewerFailure(error)));
        if (shown.current === null) interaction.emit('tank:none', {});
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, interaction, token, status, userKey, attempt]);

  useEffect(
    () => () => {
      if (shown.current === null) return;
      interaction.emit('tank:unloaded', { tankId: shown.current, reason: 'reset' });
      shown.current = null;
    },
    [interaction],
  );

  const setTank = useCallback((tank: PublicTank) => setPhase({ kind: 'ready', tank }), []);
  const retry = useCallback(() => {
    setPhase({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  return { phase, setTank, retry };
}

function Reactions({
  token,
  tank,
  onChange,
}: {
  token: string;
  tank: PublicTank;
  onChange(tank: PublicTank): void;
}) {
  const api = useApi();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReactionProblem | null>(null);

  const press = async (kind: ReactionKind) => {
    if (!user) return setProblem({ kind: 'sign-in' });
    const target = reactionTarget(tank.myReaction, kind);
    setBusy(true);
    setProblem(null);
    try {
      const next =
        target === null ? await api.clearReaction(token) : await api.setReaction(token, target);
      onChange({ ...tank, ...next });
    } catch (error) {
      setProblem(reactionProblem(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reactions">
      <div role="group" aria-label="React to this tank" className="segmented">
        {REACTION_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={tank.myReaction === kind}
            aria-label={reactionButtonName(kind, tank.reactions[kind], tank.myReaction === kind)}
            disabled={busy}
            onClick={() => void press(kind)}
          >
            <span aria-hidden="true" className="reaction-glyph">
              {GLYPH[kind]}
            </span>
            <span aria-hidden="true">{tank.reactions[kind]}</span>
          </button>
        ))}
      </div>
      <p role="status" className="hint reaction-note">
        {problem && reactionProblemText(problem)}
        {problem?.kind === 'sign-in' && (
          <>
            {' '}
            <a
              href="/sign-in"
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                leaveToViewerSignIn(publicPath(token));
              }}
            >
              Sign in
            </a>{' '}
            or{' '}
            <a
              href="/sign-up"
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                leaveToViewerSignIn(publicPath(token), '/sign-up');
              }}
            >
              create an account
            </a>
            .
          </>
        )}
      </p>
    </div>
  );
}

function Report({ tank }: { tank: PublicTank }) {
  const id = useId();
  return (
    <details className="public-report">
      <summary id={id}>Tank report</summary>
      <div aria-labelledby={id}>
        {publicReportLines(tank).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </details>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <main className="stage modal">
      <section className="panel" aria-labelledby="public-notice-h">
        <h1 id="public-notice-h" tabIndex={-1} ref={heading}>
          {title}
        </h1>
        {children}
        <p>
          <a href="/">Go to the aquarium</a>
        </p>
      </section>
    </main>
  );
}

export function PublicTankView({ token }: { token: string }) {
  const { phase, setTank, retry } = useViewer(token);
  useNoIndex(phase.kind === 'ready' ? phase.tank.name : null);

  switch (phase.kind) {
    case 'loading':
      return (
        <p className="toast public-loading" role="status">
          Opening the shared tank.
        </p>
      );
    case 'missing':
      return (
        <Notice title="Tank not found">
          <p>{MISSING_MESSAGE}</p>
        </Notice>
      );
    case 'throttled':
      return (
        <Notice title="Slow down a little">
          <p role="alert">{slowDownMessage(phase.retryAfterSeconds)}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </Notice>
      );
    case 'failed':
      return (
        <Notice title="This tank could not be opened">
          <p role="alert">{phase.message}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </Notice>
      );
    case 'ready':
      return (
        <main className="public-bar">
          <div className="public-title">
            <h1>{phase.tank.name}</h1>
            <p className="hint">A shared tank. You can look, not change.</p>
          </div>
          <Reactions token={token} tank={phase.tank} onChange={setTank} />
          <CameraControls />
          <Report tank={phase.tank} />
          <a className="public-own" href="/">
            Make your own tank
          </a>
        </main>
      );
  }
}
