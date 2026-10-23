import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_FEED_PORTION_MAX,
  COMMUNITY_FEED_PORTION_MIN,
  COMMUNITY_TANK_FEED_CAP,
  COMMUNITY_USER_FEED_QUOTA,
  communityEventSchema,
  communityFeedRequestSchema,
  communityStreamEventNameSchema,
} from './community.js';
import { errorCodeSchema } from './errors.js';

const key = 'abcdefgh12345678';

describe('community contract', () => {
  it('accepts a feed up to the per-feed maximum and no more', () => {
    const feed = (portion: number) =>
      communityFeedRequestSchema.safeParse({ food: 'flakes', portion, idempotencyKey: key });
    expect(feed(COMMUNITY_FEED_PORTION_MAX).success).toBe(true);
    expect(feed(COMMUNITY_FEED_PORTION_MAX + 0.01).success).toBe(false);
    expect(feed(COMMUNITY_FEED_PORTION_MIN).success).toBe(true);
    expect(feed(COMMUNITY_FEED_PORTION_MIN - 0.01).success).toBe(false);
    expect(feed(0).success).toBe(false);
  });

  it('requires an idempotency key and rejects unknown fields', () => {
    expect(communityFeedRequestSchema.safeParse({ food: 'flakes', portion: 0.5 }).success).toBe(
      false,
    );
    expect(
      communityFeedRequestSchema.safeParse({
        food: 'flakes',
        portion: 0.5,
        idempotencyKey: key,
        userId: 'x',
      }).success,
    ).toBe(false);
  });

  it('lets one user use no more than the whole tank allows', () => {
    expect(COMMUNITY_USER_FEED_QUOTA.portions).toBeLessThanOrEqual(
      COMMUNITY_TANK_FEED_CAP.portions,
    );
  });

  it('never carries an owner or an email in an event', () => {
    const feed = {
      type: 'feed',
      at: new Date().toISOString(),
      food: 'flakes',
      portion: 0.5,
      by: null,
    };
    expect(communityEventSchema.safeParse(feed).success).toBe(true);
    expect(communityEventSchema.safeParse({ ...feed, userId: 'u1' }).success).toBe(false);
    expect(communityEventSchema.safeParse({ ...feed, by: 'a@b.lu' }).success).toBe(false);
  });

  it('names the stream events and the quota error', () => {
    expect(communityStreamEventNameSchema.options).toEqual([
      'state',
      'viewers',
      'feed',
      'death',
      'born',
    ]);
    expect(errorCodeSchema.safeParse('quota_exceeded').success).toBe(true);
  });
});
