import {
  GALLERY_PAGE_SIZE,
  type GalleryEntry,
  type GalleryResponse,
  type GalleryTank,
  type GalleryWinner,
} from '@aquarium/shared';
import { useCallback, useEffect, useState } from 'react';
import {
  galleryLoadMessage,
  mergePage,
  showcase,
  voteLabel,
  voteProblem,
  voteProblemText,
  votesText,
  voteTarget,
  weekLabel,
  withVote,
  type VoteProblem,
} from '../sync/gallery';
import type { ReactNode } from 'react';
import { useApi, useAuth } from './context';
import { returnState } from './router';
import { Link, Panel } from './screens';

export function useVoting(onVote: (myVote: string | null) => void): {
  busy: boolean;
  problem: VoteProblem | null;
  press(tankId: string, current: string | null): Promise<void>;
} {
  const api = useApi();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<VoteProblem | null>(null);

  const press = async (tankId: string, current: string | null) => {
    if (!user) return setProblem({ kind: 'sign-in' });
    const target = voteTarget(current, tankId);
    setBusy(true);
    setProblem(null);
    try {
      const next = target === null ? await api.clearVote() : await api.castVote(target);
      onVote(next.myVote);
    } catch (error) {
      setProblem(voteProblem(error));
    } finally {
      setBusy(false);
    }
  };
  return { busy, problem, press };
}

/** Gallery tanks drive the shared scene, so every way in or out is a full page load. */
export function PageLink({ to, children }: { to: string; children: ReactNode }) {
  return <a href={to}>{children}</a>;
}

export function VoteProblemNote({
  problem,
  returnTo,
}: {
  problem: VoteProblem | null;
  returnTo: string;
}) {
  return (
    <p role="status" className="hint vote-note">
      {problem && voteProblemText(problem)}
      {problem?.kind === 'sign-in' && (
        <>
          {' '}
          <Link to="/sign-in" state={returnState(returnTo)}>
            Sign in
          </Link>{' '}
          or{' '}
          <Link to="/sign-up" state={returnState(returnTo)}>
            create an account
          </Link>
          .
        </>
      )}
    </p>
  );
}

function Summary({ tank }: { tank: GalleryTank }) {
  return (
    <>
      {tank.biome} tank, {tank.fishCount} fish alive
    </>
  );
}

function Highlight({
  heading,
  tank,
  detail,
}: {
  heading: string;
  tank: GalleryTank;
  detail: string;
}) {
  return (
    <li className="gallery-highlight">
      <h3>{heading}</h3>
      <p>
        <PageLink to={`/gallery/${tank.id}`}>{tank.name}</PageLink>
      </p>
      <p className="hint">
        <Summary tank={tank} />. {detail}
      </p>
    </li>
  );
}

function winnerDetail(winner: GalleryWinner): string {
  return `${weekLabel(winner.weekStart, winner.weekEnd)}, ${votesText(winner.votes)}.`;
}

function Showcase({
  gallery,
  winners,
}: {
  gallery: GalleryResponse;
  winners: readonly GalleryWinner[];
}) {
  const { current, last, earlier } = showcase(gallery, winners);
  return (
    <section aria-labelledby="gallery-top-h" className="gallery-showcase">
      <h2 id="gallery-top-h">Tank of the week</h2>
      <ul className="gallery-highlights">
        {current ? (
          <Highlight
            heading="Leading this week"
            tank={current}
            detail={`${votesText(current.votes)} so far.`}
          />
        ) : (
          <li className="gallery-highlight">
            <h3>Leading this week</h3>
            <p className="hint">No votes yet. Be the first to pick a tank.</p>
          </li>
        )}
        {last ? (
          <Highlight heading="Last week's winner" tank={last} detail={winnerDetail(last)} />
        ) : (
          <li className="gallery-highlight">
            <h3>Last week&apos;s winner</h3>
            <p className="hint">Nobody has won yet.</p>
          </li>
        )}
      </ul>
      {earlier.length > 0 && (
        <details>
          <summary>Earlier winners</summary>
          <ul>
            {earlier.map((winner) => (
              <li key={winner.weekStart}>
                <PageLink to={`/gallery/${winner.id}`}>{winner.name}</PageLink>{' '}
                <span className="hint">{winnerDetail(winner)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Entry({
  entry,
  myVote,
  voting,
}: {
  entry: GalleryEntry;
  myVote: string | null;
  voting: ReturnType<typeof useVoting>;
}) {
  return (
    <li className="gallery-entry">
      <h3>
        <PageLink to={`/gallery/${entry.id}`}>{entry.name}</PageLink>
      </h3>
      <p className="hint">
        <Summary tank={entry} />
      </p>
      {entry.mine ? (
        <p className="badge">Your tank, {votesText(entry.votes)}</p>
      ) : (
        <button
          type="button"
          aria-pressed={entry.voted}
          aria-label={voteLabel(entry)}
          disabled={voting.busy}
          onClick={() => void voting.press(entry.id, myVote)}
        >
          {entry.voted ? 'Voted' : 'Vote'}, {votesText(entry.votes)}
        </button>
      )}
    </li>
  );
}

export function GalleryScreen() {
  const api = useApi();
  const { status, user } = useAuth();
  const userKey = user?.id ?? '';
  const [gallery, setGallery] = useState<GalleryResponse | null>(null);
  const [winners, setWinners] = useState<readonly GalleryWinner[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (status === 'loading') return;
    let live = true;
    setError(null);
    Promise.all([
      api.gallery({ limit: GALLERY_PAGE_SIZE, offset: 0 }),
      api.galleryWinners().catch(() => ({ winners: [] as GalleryWinner[] })),
    ]).then(
      ([page, past]) => {
        if (!live) return;
        setGallery(page);
        setWinners(past.winners);
      },
      (cause: unknown) => {
        if (live) setError(galleryLoadMessage(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [api, status, userKey, attempt]);

  const voting = useVoting(
    useCallback((myVote: string | null) => setGallery((g) => (g ? withVote(g, myVote) : g)), []),
  );

  const loadMore = async () => {
    if (!gallery) return;
    setMore(true);
    try {
      const page = await api.gallery({ limit: GALLERY_PAGE_SIZE, offset: gallery.entries.length });
      setGallery((now) => (now ? mergePage(now, page) : page));
    } catch (cause) {
      setError(galleryLoadMessage(cause));
    } finally {
      setMore(false);
    }
  };

  return (
    <Panel title="Tank gallery" wide>
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      )}
      {!gallery && !error && <p role="status">Loading the gallery.</p>}
      {gallery && (
        <>
          <p className="hint">
            Week of {weekLabel(gallery.weekStart, gallery.weekEnd)}. You have one vote a week. Pick
            again to move it, or press your pick to take it back.
          </p>
          <Showcase gallery={gallery} winners={winners} />
          <VoteProblemNote problem={voting.problem} returnTo="/gallery" />
          <section aria-labelledby="gallery-all-h">
            <h2 id="gallery-all-h">This week&apos;s tanks</h2>
            {gallery.entries.length === 0 ? (
              <p>
                No tanks are listed yet. Share your tank and turn on &ldquo;Show in gallery&rdquo;
                to be the first.
              </p>
            ) : (
              <ul className="gallery-list">
                {gallery.entries.map((entry) => (
                  <Entry key={entry.id} entry={entry} myVote={gallery.myVote} voting={voting} />
                ))}
              </ul>
            )}
            {gallery.entries.length < gallery.total && (
              <button type="button" disabled={more} onClick={() => void loadMore()}>
                Show more tanks
              </button>
            )}
          </section>
        </>
      )}
      <p className="alt">
        <Link to="/">Back to the tank</Link>
      </p>
    </Panel>
  );
}
