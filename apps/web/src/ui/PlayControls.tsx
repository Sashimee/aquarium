import { foodTypeSchema, type FoodType } from '@aquarium/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTool } from '../interaction/events';
import { useBridge, usePlayTool } from './context';

const TOOLS: readonly { tool: PlayTool; label: string }[] = [
  { tool: 'tap', label: 'Tap glass' },
  { tool: 'feed', label: 'Hand-feed' },
  { tool: 'laser', label: 'Laser' },
  { tool: 'wand', label: 'Bubbles' },
];

const FOOD_LABEL: Record<FoodType, string> = {
  flakes: 'Flakes',
  pellets: 'Pellets',
  bloodworms: 'Bloodworms',
  'brine-shrimp': 'Brine shrimp',
  nori: 'Nori',
  'algae-wafer': 'Algae wafer',
};

export function PlayControls() {
  const { interaction } = useBridge();
  const tool = usePlayTool();
  const [food, setFood] = useState<FoodType>('flakes');
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A live region only speaks when its text changes, so clear it first to repeat a message.
  const announce = useCallback((text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage('');
    timer.current = setTimeout(() => setMessage(text), 60);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    interaction.emit('feed:select', { food });
  }, [interaction, food, ready]);

  useEffect(() => {
    const offs = [
      interaction.on('play:ready', () => setReady(true)),
      interaction.on('feed:dropped', ({ food: f }) =>
        announce(`Fed ${FOOD_LABEL[f].toLowerCase()}.`),
      ),
      interaction.on('feed:rejected', ({ reason, retryAfterMs }) =>
        announce(
          reason === 'tank-full'
            ? 'There is too much uneaten food in the tank. Wait for the fish to finish.'
            : `Feeding too often. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
        ),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [interaction, announce]);

  return (
    <div role="group" aria-label="Play and feed" className="play-controls">
      <select
        aria-label="Food"
        value={food}
        onChange={(e) => setFood(foodTypeSchema.parse(e.target.value))}
      >
        {foodTypeSchema.options.map((f) => (
          <option key={f} value={f}>
            {FOOD_LABEL[f]}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!ready}
        onClick={() => interaction.emit('feed:request', { food, portion: 1 })}
      >
        Feed
      </button>
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          type="button"
          aria-pressed={tool === t.tool}
          disabled={!ready}
          onClick={() => interaction.emit('play:request-tool', { tool: t.tool })}
        >
          {t.label}
        </button>
      ))}
      <span role="status" aria-live="polite" className="play-message">
        {ready ? message : 'The tank is still loading.'}
      </span>
    </div>
  );
}
