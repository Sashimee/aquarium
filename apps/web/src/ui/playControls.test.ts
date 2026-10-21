import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import type { GameView } from '../interaction/play/game';
import { UiProviders } from './context';
import type { Plant } from '@aquarium/shared';
import { fishFixture, FISH_1 } from '../sync/fixtures';
import {
  FeedingGamePanel,
  gameRequestFor,
  playTools,
  ToyShelf,
  trimShortcuts,
} from './PlayControls';

function bridge() {
  return {
    engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
    interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
  };
}

function render(b: ReturnType<typeof bridge>, child: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(UiProviders, { bridge: b, children: child })).replace(
    /<!-- -->/g,
    '',
  );
}

const FISH = [
  { id: 'f1', name: 'Glint', species: 'guppy' },
  { id: 'f2', name: 'Bolt', species: 'betta' },
];

describe('ToyShelf', () => {
  it('shows nothing until a toy is in the tank', () => {
    const b = bridge();
    expect(render(b, createElement(ToyShelf))).toBe('');
    b.interaction.emit('toys:changed', { mirror: false, ball: false });
    expect(render(b, createElement(ToyShelf))).toBe('');
  });

  it('offers to remove only the toys that are in', () => {
    const b = bridge();
    b.interaction.emit('toys:changed', { mirror: true, ball: false });
    const html = render(b, createElement(ToyShelf));
    expect(html).toContain('Remove mirror');
    expect(html).not.toContain('Remove ball');
    b.interaction.emit('toys:changed', { mirror: true, ball: true });
    const both = render(b, createElement(ToyShelf));
    expect(both).toContain('Remove mirror');
    expect(both).toContain('Remove ball');
    expect(both).toContain('aria-label="Toys in the tank"');
  });
});

describe('FeedingGamePanel', () => {
  const panel = (b: ReturnType<typeof bridge>) =>
    render(b, createElement(FeedingGamePanel, { fish: FISH }));

  it('explains that every pinch is a real feed', () => {
    expect(panel(bridge())).toContain('Every pinch is a real feed');
  });

  it('keeps the start button off until the engine is ready for play', () => {
    const b = bridge();
    expect(panel(b)).toMatch(/<button[^>]*disabled[^>]*>Start round/);
    b.interaction.emit('play:ready', {});
    expect(panel(b)).not.toMatch(/<button[^>]*disabled[^>]*>Start round/);
  });

  it('shows the live round and a stop button', () => {
    const b = bridge();
    b.interaction.emit('play:ready', {});
    const view: GameView = {
      phase: 'running',
      targetId: 'f1',
      targetName: 'Glint',
      timeLeftS: 12.3,
      pinchesLeft: 3,
      score: 40,
      best: 90,
    };
    b.interaction.emit('game:state', { view });
    const html = panel(b);
    expect(html).toContain('Feed Glint. 13 s left, 3 pinches, score 40.');
    expect(html).toContain('Best score: 90');
    expect(html).toContain('Stop round');
    expect(html).not.toContain('Start round');
  });

  it('reports a finished round, a new best and a fish that missed out', () => {
    const b = bridge();
    b.interaction.emit('game:state', {
      view: {
        phase: 'done',
        targetName: 'Glint',
        score: 120,
        best: 120,
        newBest: true,
        targetAte: true,
      },
    });
    expect(panel(b)).toContain('Glint got a bite. Score 120. New best!');
    b.interaction.emit('game:state', {
      view: {
        phase: 'done',
        targetName: 'Glint',
        score: 0,
        best: 120,
        newBest: false,
        targetAte: false,
      },
    });
    const html = panel(b);
    expect(html).toContain('Glint missed out. Score 0. Best 120.');
    expect(html).toContain('Start round');
  });

  it('shows why a round cannot start', () => {
    const b = bridge();
    b.interaction.emit('game:state', {
      view: { phase: 'unavailable', reason: 'You need at least two fish.', best: 0 },
    });
    expect(panel(b)).toContain('You need at least two fish.');
  });
});

describe('gameRequestFor', () => {
  it('starts a round with the live fish and stops a running one', () => {
    expect(gameRequestFor(false, FISH)).toEqual({ action: 'start', fish: FISH });
    expect(gameRequestFor(true, FISH)).toEqual({ action: 'stop' });
  });
});

describe('trim tool', () => {
  const fern = (key: string, size: number): Plant => ({
    key,
    assetId: 'plant-fern',
    tintSeed: 1,
    parentKey: null,
    position: null,
    size,
    minSize: 0.4,
    maxSize: 2,
  });
  const names = (tank: Parameters<typeof playTools>[0]) => playTools(tank).map((t) => t.tool);

  it('is offered once a plant has grown and lists the largest first', () => {
    const tank = { fish: [], plants: [fern('s1', 1.2), fern('s2', 1.9), fern('s3', 0.4)] };
    expect(names(tank)).toContain('trim');
    expect(trimShortcuts(tank).map((p) => p.key)).toEqual(['s2', 's1']);
  });

  it('is left out with no grown plant, no growth state or no tank (a public tank)', () => {
    expect(names({ fish: [], plants: [fern('s3', 0.4)] })).not.toContain('trim');
    expect(names({ fish: [] })).not.toContain('trim');
    expect(names(null)).not.toContain('trim');
  });

  it('sits next to the net when a fish has died', () => {
    const dead = fishFixture(FISH_1, { status: 'dead' });
    expect(names({ fish: [dead], plants: [fern('s1', 1.5)] }).slice(-2)).toEqual(['net', 'trim']);
  });
});
