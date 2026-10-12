import { foodTypeSchema, type FoodType } from '@aquarium/shared';
import { useEffect, useState } from 'react';
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

  useEffect(() => {
    const offs = [
      interaction.on('feed:dropped', ({ food: f }) =>
        setMessage(`Fed ${FOOD_LABEL[f].toLowerCase()}.`),
      ),
      interaction.on('feed:rejected', ({ reason, retryAfterMs }) =>
        setMessage(
          reason === 'tank-full'
            ? 'There is too much uneaten food in the tank. Wait for the fish to finish.'
            : `Feeding too often. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
        ),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [interaction]);

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
      <button type="button" onClick={() => interaction.emit('feed:request', { food, portion: 1 })}>
        Feed
      </button>
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          type="button"
          aria-pressed={tool === t.tool}
          onClick={() => interaction.emit('play:request-tool', { tool: t.tool })}
        >
          {t.label}
        </button>
      ))}
      <span role="status" aria-live="polite" className="play-message">
        {message}
      </span>
    </div>
  );
}
