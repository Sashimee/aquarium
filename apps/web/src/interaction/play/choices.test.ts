import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../engine/events';
import { FeedGate } from '../../sync/feedGate';
import type { InteractionEvents } from '../events';
import { FoodLink } from '../food/link';
import { FoodField } from '../food/particles';
import { sceneToSim } from '../food/simSpace';
import { BubbleField } from './bubbles';
import { PlayChoices } from './choices';
import { PlayController } from './controller';
import { RippleField } from './ripples';

const MIN = { x: -0.59, y: 0.011, z: -0.24 };
const MAX = { x: 0.59, y: 0.47, z: 0.24 };

function controllerOn(events: EventBus<InteractionEvents>, gate = new FeedGate()) {
  const food = new FoodField(
    {
      bounds: { minX: MIN.x, maxX: MAX.x, minZ: MIN.z, maxZ: MAX.z, waterTop: MAX.y },
      groundHeight: () => 0.06,
      current: (_x, _y, _z, out) => {
        out[0] = out[1] = out[2] = 0;
      },
    },
    () => 0.5,
  );
  return new PlayController({
    rayAt: () => ({ origin: { x: 0.1, y: 1, z: 0.05 }, dir: { x: 0, y: -1, z: 0 } }),
    min: MIN,
    max: MAX,
    food,
    link: new FoodLink(food, {}, sceneToSim, () => undefined),
    bubbles: new BubbleField(MAX.y, () => 0.5),
    ripples: new RippleField(),
    gate,
    events,
    toSim: sceneToSim,
    setLaserDot: () => undefined,
    now: () => 10_000,
  });
}

describe('PlayChoices', () => {
  it('hands the UI tool and food to the controller built for the next scene', () => {
    const events = new EventBus<InteractionEvents>();
    const choices = new PlayChoices(events);
    const first = controllerOn(events);
    events.on('play:request-tool', ({ tool }) => first.setTool(tool));
    events.emit('play:request-tool', { tool: 'feed' });
    events.emit('feed:select', { food: 'pellets' });
    first.dispose();

    const second = controllerOn(events);
    const tools = vi.fn();
    events.on('play:tool-changed', tools);
    const dropped = vi.fn();
    events.on('feed:dropped', dropped);
    choices.applyTo(second);

    expect(second.tool).toBe('feed');
    expect(tools).toHaveBeenCalledWith({ tool: 'feed' });
    second.tap(0, 0);
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({ food: 'pellets' }));
  });

  it('applies a tool picked while no controller was listening', () => {
    const events = new EventBus<InteractionEvents>();
    const choices = new PlayChoices(events);
    events.emit('play:request-tool', { tool: 'laser' });
    const controller = controllerOn(events);
    choices.applyTo(controller);
    expect(controller.tool).toBe('laser');
    expect(controller.claimsDrag).toBe(true);
  });

  it('keeps the defaults when nothing was chosen', () => {
    const events = new EventBus<InteractionEvents>();
    const choices = new PlayChoices(events);
    const controller = controllerOn(events);
    const dropped = vi.fn();
    events.on('feed:dropped', dropped);
    choices.applyTo(controller);
    expect(controller.tool).toBe('tap');
    controller.setTool('feed');
    controller.tap(0, 0);
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({ food: 'flakes' }));
  });

  it('keeps the feed cooldown across controllers that share a gate', () => {
    const events = new EventBus<InteractionEvents>();
    const gate = new FeedGate({ cooldownMs: 60_000 });
    const rejected = vi.fn();
    events.on('feed:rejected', rejected);
    const first = controllerOn(events, gate);
    events.emit('feed:request', { food: 'flakes', portion: 1 });
    first.dispose();
    controllerOn(events, gate);
    events.emit('feed:request', { food: 'flakes', portion: 1 });
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rate-limited' }));
  });

  it('stops following the bus once stopped', () => {
    const events = new EventBus<InteractionEvents>();
    const choices = new PlayChoices(events);
    choices.stop();
    events.emit('play:request-tool', { tool: 'wand' });
    const controller = controllerOn(events);
    choices.applyTo(controller);
    expect(controller.tool).toBe('tap');
  });

  it('never keeps the game tool, which belongs to a round the next scene does not have', () => {
    const events = new EventBus<InteractionEvents>();
    const choices = new PlayChoices(events);
    events.emit('play:request-tool', { tool: 'laser' });
    events.emit('play:tool-changed', { tool: 'game' });
    events.emit('play:request-tool', { tool: 'game' });
    const next = controllerOn(events);
    choices.applyTo(next);
    expect(next.tool).toBe('laser');
  });
});
