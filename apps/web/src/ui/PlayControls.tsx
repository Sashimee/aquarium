import { foodTypeSchema, type FoodType } from '@aquarium/shared';
import { useEffect, useRef, useState } from 'react';
import {
  HAND_FEED_PORTION,
  type GameFishRef,
  type InteractionEvents,
  type PlayTool,
} from '../interaction/events';
import { useBridge, useLatest, usePlayTool } from './context';
import { useActiveTank } from './session';

const TOOLS: readonly { tool: PlayTool; label: string; hint: string }[] = [
  { tool: 'tap', label: 'Tap glass', hint: 'Startle the fish' },
  { tool: 'feed', label: 'Hand-feed', hint: 'Hold food at the surface' },
  { tool: 'laser', label: 'Laser', hint: 'Fish chase the dot' },
  { tool: 'wand', label: 'Bubbles', hint: 'Blow a stream of bubbles' },
  { tool: 'mirror', label: 'Mirror', hint: 'Tap the far glass to hang it' },
  { tool: 'ball', label: 'Ping-pong ball', hint: 'Tap the tank, then flick it' },
];

const NET: { tool: PlayTool; label: string; hint: string } = {
  tool: 'net',
  label: 'Net',
  hint: 'Lift out a fish that has died',
};

const FOOD_LABEL: Record<FoodType, string> = {
  flakes: 'Flakes',
  pellets: 'Pellets',
  bloodworms: 'Bloodworms',
  'brine-shrimp': 'Brine shrimp',
  nori: 'Nori',
  'algae-wafer': 'Algae wafer',
};

export function useEngineReadyForPlay(): boolean {
  const { interaction } = useBridge();
  return useLatest(interaction, 'play:ready') !== undefined;
}

/** Keeps the engine's selected food in step for the whole session, not only while the feed sheet is open. */
export function useFood(): [FoodType, (food: FoodType) => void] {
  const { interaction } = useBridge();
  const [food, setFood] = useState<FoodType>('flakes');
  const ready = useEngineReadyForPlay();
  useEffect(() => {
    interaction.emit('feed:select', { food });
  }, [interaction, food, ready]);
  return [food, setFood];
}

const TOAST_MS = 4500;

/** A live region only speaks when its text changes, so the text is cleared first to repeat a message. */
export function FeedToast() {
  const { interaction } = useBridge();
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const announce = (text: string) => {
      if (timer.current) clearTimeout(timer.current);
      if (clear.current) clearTimeout(clear.current);
      setMessage('');
      timer.current = setTimeout(() => setMessage(text), 60);
      clear.current = setTimeout(() => setMessage(''), TOAST_MS);
    };
    const offs = [
      interaction.on('camera:follow-unavailable', () =>
        announce('There is no fish to follow yet.'),
      ),
      interaction.on('feed:dropped', ({ food }) =>
        announce(`Fed ${FOOD_LABEL[food].toLowerCase()}.`),
      ),
      interaction.on('feed:rejected', ({ reason, retryAfterMs }) =>
        announce(
          reason === 'unreachable'
            ? 'Too tight for your fish to reach. Clip the nori somewhere roomier.'
            : reason === 'tank-full'
              ? 'There is too much uneaten food in the tank. Wait for the fish to finish.'
              : `Feeding too often. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
        ),
      ),
    ];
    return () => {
      offs.forEach((off) => off());
      if (timer.current) clearTimeout(timer.current);
      if (clear.current) clearTimeout(clear.current);
    };
  }, [interaction]);

  return (
    <div role="status" aria-live="polite" className="toast-live">
      {message && <p className="toast play-message">{message}</p>}
    </div>
  );
}

export function FeedPanel({ food, onFood }: { food: FoodType; onFood(food: FoodType): void }) {
  const { interaction } = useBridge();
  const ready = useEngineReadyForPlay();
  return (
    <div className="feed-controls">
      <label htmlFor="food-select">Food</label>
      <select
        id="food-select"
        value={food}
        onChange={(e) => onFood(foodTypeSchema.parse(e.target.value))}
      >
        {foodTypeSchema.options.map((f) => (
          <option key={f} value={f}>
            {FOOD_LABEL[f]}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="primary big"
        disabled={!ready}
        onClick={() => interaction.emit('feed:request', { food, portion: HAND_FEED_PORTION })}
      >
        Drop food
      </button>
      <p className="hint">A little at a time. Uneaten food rots and poisons the water.</p>
    </div>
  );
}

export function PlayPanel() {
  const { interaction } = useBridge();
  const tool = usePlayTool();
  const tank = useActiveTank();
  const ready = useEngineReadyForPlay();
  const tools = tank?.fish.some((f) => f.status === 'dead') ? [...TOOLS, NET] : TOOLS;
  return (
    <>
      <div role="group" aria-label="Play tools" className="tool-grid">
        {tools.map((t) => (
          <button
            key={t.tool}
            type="button"
            className="tool"
            aria-label={t.label}
            aria-pressed={tool === t.tool}
            disabled={!ready}
            onClick={() => interaction.emit('play:request-tool', { tool: t.tool })}
          >
            <strong>{t.label}</strong>
            <span>{t.hint}</span>
          </button>
        ))}
      </div>
      <ToyShelf />
      <FeedingGamePanel
        fish={(tank?.fish ?? [])
          .filter((f) => f.status === 'alive')
          .map((f) => ({ id: f.id, name: f.name, species: f.species }))}
      />
    </>
  );
}

export function ToyShelf() {
  const { interaction } = useBridge();
  const toys = useLatest(interaction, 'toys:changed');
  if (!toys || (!toys.mirror && !toys.ball)) return null;
  return (
    <div role="group" aria-label="Toys in the tank" className="toy-shelf">
      {toys.mirror && (
        <button type="button" onClick={() => interaction.emit('toys:remove', { toy: 'mirror' })}>
          Remove mirror
        </button>
      )}
      {toys.ball && (
        <button type="button" onClick={() => interaction.emit('toys:remove', { toy: 'ball' })}>
          Remove ball
        </button>
      )}
    </div>
  );
}

export function gameRequestFor(
  running: boolean,
  fish: readonly GameFishRef[],
): InteractionEvents['game:request'] {
  return running ? { action: 'stop' } : { action: 'start', fish };
}

export function FeedingGamePanel({ fish }: { fish: readonly GameFishRef[] }) {
  const { interaction } = useBridge();
  const ready = useEngineReadyForPlay();
  const state = useLatest(interaction, 'game:state');
  const view = state?.view;
  const running = view?.phase === 'running';
  return (
    <section className="game" aria-labelledby="game-title">
      <h3 id="game-title">Shy fish feeding game</h3>
      <p className="hint">
        Tap the tank to drop five pinches in before the bold fish take them. The shy fish scores,
        the others cost you. Every pinch is a real feed: it counts toward the feeding limit and
        leftovers foul the water.
      </p>
      {view?.phase === 'running' && (
        <p role="status" className="game-status">
          Feed {view.targetName}. {Math.ceil(view.timeLeftS)} s left, {view.pinchesLeft} pinches,
          score {view.score}.
        </p>
      )}
      {view?.phase === 'done' && (
        <p role="status" className="game-status">
          {view.targetAte
            ? `${view.targetName} got a bite. Score ${view.score}.`
            : `${view.targetName} missed out. Score ${view.score}.`}{' '}
          {view.newBest ? 'New best!' : `Best ${view.best}.`}
        </p>
      )}
      {view?.phase === 'unavailable' && <p className="hint">{view.reason}</p>}
      <p className="hint">Best score: {view?.best ?? 0}</p>
      <button
        type="button"
        className="primary"
        disabled={!ready}
        onClick={() => interaction.emit('game:request', gameRequestFor(running, fish))}
      >
        {running ? 'Stop round' : 'Start round'}
      </button>
    </section>
  );
}
