import { foodTypeSchema, type FoodType } from '@aquarium/shared';
import { useEffect, useRef, useState } from 'react';
import { HAND_FEED_PORTION, type PlayTool } from '../interaction/events';
import { useBridge, useLatest, usePlayTool } from './context';
import { useActiveTank } from './session';

const TOOLS: readonly { tool: PlayTool; label: string; hint: string }[] = [
  { tool: 'tap', label: 'Tap glass', hint: 'Startle the fish' },
  { tool: 'feed', label: 'Hand-feed', hint: 'Hold food at the surface' },
  { tool: 'laser', label: 'Laser', hint: 'Fish chase the dot' },
  { tool: 'wand', label: 'Bubbles', hint: 'Blow a stream of bubbles' },
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
  );
}
