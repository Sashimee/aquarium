import { describe, expect, it } from 'vitest';
import { FeedingGame, type GameFish } from './game';

const FISH: readonly GameFish[] = [
  { id: 'shy', name: 'Glint', boldness: 0.1, eligible: true },
  { id: 'bold', name: 'Bolt', boldness: 0.9, eligible: true },
];

function running(): FeedingGame {
  const game = new FeedingGame({ read: () => 0, write: () => undefined }, () => 0);
  game.start(FISH);
  return game;
}

function timeLeft(game: FeedingGame): number {
  const view = game.view;
  if (view.phase !== 'running') throw new Error('round is not running');
  return view.timeLeftS;
}

describe('FeedingGame view', () => {
  it('reuses the view inside one displayed second, so timeLeftS may lag', () => {
    const game = running();
    const first = game.update(0.1);
    const second = game.update(0.1);
    expect(second).toBe(first);
    expect(timeLeft(game)).toBe(20);
  });

  it('makes a new view once the displayed second changes', () => {
    const game = running();
    const first = game.update(0.1);
    const second = game.update(1);
    expect(second).not.toBe(first);
    expect(timeLeft(game)).toBeCloseTo(18.9, 5);
  });
});
