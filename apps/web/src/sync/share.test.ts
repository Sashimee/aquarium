import {
  DEFAULT_EQUIPMENT,
  newTankChemistry,
  type PublicFish,
  type PublicTank,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import type { LampSchedule } from '../engine/daylight';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { ApiRequestError } from '../ui/api';
import { LampFeed } from './lampFeed';
import {
  announcePublicTank,
  publicFishAsFish,
  publicPath,
  publicReportLines,
  publicTankLoaded,
  publicUrl,
  reactionButtonName,
  reactionProblem,
  reactionProblemText,
  reactionTarget,
  shareView,
  tokenFromPath,
  viewerFailure,
} from './share';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';

const fish = (overrides: Partial<PublicFish> = {}): PublicFish => ({
  species: 'neon-tetra',
  name: 'Zip',
  sex: 'female',
  stage: 'adult',
  personality: { boldness: 0.5, greed: 0.5, sociability: 0.5 },
  disease: null,
  bornAt: '2026-01-01T00:00:00.000Z',
  size: 0.03,
  hunger: 0.1,
  health: 1,
  status: 'alive',
  diedAt: null,
  cause: null,
  seed: 255,
  ...overrides,
});

const tank = (overrides: Partial<PublicTank> = {}): PublicTank => ({
  name: 'Reef of Ann',
  biome: 'freshwater',
  size: 'standard',
  seed: 4096,
  backgroundId: 'bg-fw-planted-stream',
  roomId: 'room-living',
  decorLayout: [],
  decorEdited: false,
  water: { ammonia: 0, nitrate: 0, algae: 0, tannin: 0, uneatenFood: 0 },
  chemistry: newTankChemistry('freshwater'),
  equipment: DEFAULT_EQUIPMENT,
  fish: [fish()],
  snapshotAt: '2026-02-01T00:00:00.000Z',
  reactions: { heart: 0, star: 0, wow: 0 },
  myReaction: null,
  ...overrides,
});

const failure = (status: number, code: ApiRequestError['code'], retryAfter: number | null = null) =>
  new ApiRequestError(status, code, `${code} message`, {}, retryAfter);

describe('share links', () => {
  it('builds and reads back the viewer path', () => {
    expect(publicPath(TOKEN)).toBe(`/t/${TOKEN}`);
    expect(publicUrl('https://fish.bas.lu', TOKEN)).toBe(`https://fish.bas.lu/t/${TOKEN}`);
    expect(tokenFromPath(`/t/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromPath(`/t/${TOKEN}/`)).toBe(TOKEN);
  });

  it.each(['/t/', '/t/short', `/t/${TOKEN}x`, `/t/${TOKEN}/more`, `/x/${TOKEN}`, '/'])(
    'rejects %s',
    (path) => {
      expect(tokenFromPath(path)).toBeNull();
    },
  );
});

describe('owner share state', () => {
  it('is private until shared', () => {
    expect(shareView({ shared: false }, null)).toEqual({ kind: 'private' });
    expect(shareView({ shared: false }, TOKEN)).toEqual({ kind: 'private' });
  });

  it('shows the link only while the issuing response is in hand', () => {
    expect(shareView({ shared: true }, TOKEN)).toEqual({ kind: 'fresh', token: TOKEN });
  });

  it('offers a new link when shared without a readable token', () => {
    expect(shareView({ shared: true }, null)).toEqual({ kind: 'link-hidden' });
  });
});

describe('viewer failures', () => {
  it('treats unknown and revoked links alike as missing', () => {
    expect(viewerFailure(failure(404, 'not_found'))).toEqual({ kind: 'missing' });
  });

  it('carries the retry delay when throttled', () => {
    expect(viewerFailure(failure(429, 'rate_limited', 30))).toEqual({
      kind: 'throttled',
      retryAfterSeconds: 30,
    });
    expect(viewerFailure(failure(429, 'rate_limited'))).toEqual({
      kind: 'throttled',
      retryAfterSeconds: null,
    });
  });

  it('keeps the message of other failures and wraps unknown errors', () => {
    expect(viewerFailure(failure(0, 'network'))).toEqual({
      kind: 'failed',
      message: 'network message',
    });
    expect(viewerFailure(new Error('boom'))).toMatchObject({ kind: 'failed' });
  });
});

describe('reaction problems', () => {
  it.each([
    [failure(401, 'unauthenticated'), 'sign-in'],
    [failure(403, 'email_not_verified'), 'verify'],
    [new ApiRequestError(403, 'own_tank', 'Reworded server copy.', {}, null), 'own'],
    [
      new ApiRequestError(403, 'forbidden', 'You cannot react to your own tank.', {}, null),
      'failed',
    ],
    [new ApiRequestError(403, 'forbidden', 'Cross-origin request rejected.', {}, null), 'failed'],
    [failure(404, 'not_found'), 'gone'],
    [failure(429, 'rate_limited', 12), 'slow'],
    [failure(500, 'internal'), 'failed'],
    [new Error('x'), 'failed'],
  ])('maps %#', (error, kind) => {
    expect(reactionProblem(error).kind).toBe(kind);
  });

  it('tells the visitor what to do', () => {
    expect(reactionProblemText({ kind: 'sign-in' })).toMatch(/sign in/i);
    expect(reactionProblemText({ kind: 'slow', seconds: 12 })).toContain('12 seconds');
    expect(reactionProblemText({ kind: 'slow', seconds: null })).toMatch(/moment/);
    expect(reactionProblemText({ kind: 'gone' })).toMatch(/not shared/);
  });
});

describe('reaction choice', () => {
  it('sets a new reaction, switches, and takes back the current one', () => {
    expect(reactionTarget(null, 'heart')).toBe('heart');
    expect(reactionTarget('heart', 'star')).toBe('star');
    expect(reactionTarget('star', 'star')).toBeNull();
  });

  it('names each button with its count and whether it is yours', () => {
    expect(reactionButtonName('heart', 1, false)).toBe('Heart, 1 reaction');
    expect(reactionButtonName('wow', 0, false)).toBe('Wow, 0 reactions');
    expect(reactionButtonName('star', 3, true)).toBe('Star, 3 reactions, your choice');
  });
});

describe('public tank to scene', () => {
  it('gives fish stable synthetic ids from their seeds', () => {
    const a = publicFishAsFish(tank(), fish({ seed: 255 }));
    const b = publicFishAsFish(tank(), fish({ seed: 256 }));
    expect(a.id).toBe('public:ff');
    expect(a.id).not.toBe(b.id);
    expect(a.tankId).toBe('public:1000');
  });

  it('follows the server flag on whether the decor was edited', () => {
    expect(publicTankLoaded(tank()).decorEdited).toBe(false);
    const item = {
      assetId: 'rock-a',
      position: [0, 0, 0] as [number, number, number],
      rotationY: 0,
      scale: 1,
    };
    const edited = publicTankLoaded(tank({ decorEdited: true, decorLayout: [item] }));
    expect(edited.decorEdited).toBe(true);
    expect(edited.decorLayout).toHaveLength(1);
    expect(edited.fish).toHaveLength(1);
    expect(edited).not.toHaveProperty('recentVisitDays');
    expect(edited.biome).toBe('freshwater');
  });

  it('points the hood at the shared tank own lamp hours, not the viewer last tank', () => {
    const bus = new EventBus<InteractionEvents>();
    const feed = new LampFeed(bus);
    const seen: LampSchedule[] = [];
    feed.attach({ setLampSchedule: (h) => seen.push(h) });
    bus.emit('tank:loaded', { ...publicTankLoaded(tank()), tankId: 'mine' });
    bus.emit('tank:lamp', { tankId: 'mine', intensity: 1, onHour: 5, offHour: 9 });
    const shared = tank({
      equipment: {
        ...tank().equipment,
        light: { ...tank().equipment.light, intensity: 0.4, onHour: 14, offHour: 23 },
      },
    });
    announcePublicTank(bus, shared);
    expect(seen.at(-1)).toEqual({ intensity: 0.4, onHour: 14, offHour: 23 });
  });

  it('keeps an emptied layout empty instead of showing the preset', () => {
    const loaded = publicTankLoaded(tank({ decorEdited: true, decorLayout: [] }));
    expect(loaded.decorEdited).toBe(true);
    expect(loaded.decorLayout).toEqual([]);
  });

  it('writes a plain text report, dead fish included', () => {
    const lines = publicReportLines(
      tank({ fish: [fish(), fish({ name: 'Old', status: 'dead', seed: 1 })] }),
    );
    expect(lines[0]).toContain('Reef of Ann, a shared freshwater tank');
    expect(lines[1]).toBe('1 fish alive: Zip the Neon tetra.');
    expect(lines[2]).toBe('Old has died.');
    expect(publicReportLines(tank({ fish: [] }))[1]).toBe('No fish are alive in this tank.');
  });
});
