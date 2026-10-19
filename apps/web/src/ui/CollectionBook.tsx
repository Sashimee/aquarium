import type { AchievementList, Collection } from '@aquarium/shared';
import { useCallback, useEffect, useState } from 'react';
import {
  achievementRow,
  collectionErrorMessage,
  collectionSummary,
  speciesCard,
} from './collectionBook';
import { useApi } from './context';
import { Dialog } from './Dialog';

export type BookTab = 'species' | 'achievements';

export type BookState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; collection: Collection; achievements: AchievementList };

export function CollectionBody({
  state,
  tab,
  onTab,
  onRetry,
  onClose,
}: {
  state: BookState;
  tab: BookTab;
  onTab(tab: BookTab): void;
  onRetry(): void;
  onClose(): void;
}) {
  return (
    <div className="book">
      <div className="book-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {state.status === 'loading' && <p role="status">Opening the book.</p>}
      {state.status === 'error' && (
        <div role="alert" className="book-error">
          <p>{state.message}</p>
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <p className="book-summary">{collectionSummary(state.collection)}</p>
          <div role="group" aria-label="Book section" className="segmented book-tabs">
            <button type="button" aria-pressed={tab === 'species'} onClick={() => onTab('species')}>
              Species
            </button>
            <button
              type="button"
              aria-pressed={tab === 'achievements'}
              onClick={() => onTab('achievements')}
            >
              Achievements
            </button>
          </div>
          {tab === 'species' ? (
            <SpeciesList collection={state.collection} />
          ) : (
            <AchievementsList list={state.achievements} />
          )}
        </>
      )}
    </div>
  );
}

function SpeciesList({ collection }: { collection: Collection }) {
  return (
    <ul className="book-grid" aria-label="Species">
      {collection.species.map((row) => {
        const card = speciesCard(row);
        if (card.kind === 'locked') {
          return (
            <li
              key={card.species}
              className="book-card locked"
              data-state="locked"
              tabIndex={0}
              aria-label={`Undiscovered ${card.biome} species. Keep one to unlock it.`}
            >
              <span className="book-fish" aria-hidden="true" />
              <span className="book-name" aria-hidden="true">
                ???
              </span>
              <span className="book-meta" aria-hidden="true">
                Undiscovered
              </span>
            </li>
          );
        }
        return (
          <li
            key={card.species}
            className="book-card"
            data-species={card.species}
            data-state="found"
            tabIndex={0}
          >
            <span className="book-fish found" aria-hidden="true" />
            <span className="book-name">{card.name}</span>
            <span className="book-meta">First kept {card.keptOn}</span>
            {card.milestones.map((m) => (
              <span key={m} className="book-meta">
                {m}
              </span>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

function AchievementsList({ list }: { list: AchievementList }) {
  return (
    <ul className="book-list" aria-label="Achievements">
      {list.achievements.map((a) => {
        const row = achievementRow(a);
        return (
          <li
            key={row.id}
            className="book-achievement"
            data-achievement={row.id}
            data-earned={row.earned}
            tabIndex={0}
          >
            <strong>{row.title}</strong>
            <span>{row.description}</span>
            <progress
              value={row.progress}
              max={row.target}
              aria-label={`${row.title} progress`}
              aria-valuetext={row.progressText}
            />
            <span className="book-meta">
              {row.earnedOn ? `Earned ${row.earnedOn}` : row.progressText}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function CollectionBook({ onClose }: { onClose(): void }) {
  const api = useApi();
  const [state, setState] = useState<BookState>({ status: 'loading' });
  const [tab, setTab] = useState<BookTab>('species');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    Promise.all([api.collection(), api.achievements()]).then(
      ([collection, achievements]) => {
        if (current) setState({ status: 'ready', collection, achievements });
      },
      (cause: unknown) => {
        console.error(cause);
        if (current) setState({ status: 'error', message: collectionErrorMessage(cause) });
      },
    );
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <Dialog title="Collection book" onClose={onClose}>
      <CollectionBody state={state} tab={tab} onTab={setTab} onRetry={retry} onClose={onClose} />
    </Dialog>
  );
}
