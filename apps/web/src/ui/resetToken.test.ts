import { describe, expect, it } from 'vitest';
import {
  readResetState,
  stateWithResetDone,
  stateWithToken,
  stateWithoutToken,
  withoutTokenParam,
} from './resetToken';

describe('withoutTokenParam', () => {
  it('removes only the token and keeps other params and the hash', () => {
    expect(
      withoutTokenParam({
        pathname: '/reset-password',
        search: '?backend=webgl2&token=abc&x=1',
        hash: '#frag',
      }),
    ).toBe('/reset-password?backend=webgl2&x=1#frag');
  });

  it('leaves no dangling ? when the token was the only param', () => {
    expect(withoutTokenParam({ pathname: '/reset-password', search: '?token=abc', hash: '' })).toBe(
      '/reset-password',
    );
  });
});

describe('reset history state', () => {
  it('round-trips the token and preserves unrelated state', () => {
    const state = stateWithToken({ keep: 1 }, 'tok');
    expect(state).toMatchObject({ keep: 1 });
    expect(readResetState(state)).toEqual({ token: 'tok', done: false });
  });

  it('clears the token and marks done after success', () => {
    const state = stateWithResetDone(stateWithToken(null, 'secret-token'));
    expect(readResetState(state)).toEqual({ token: null, done: true });
    expect(JSON.stringify(state)).not.toContain('secret-token');
  });

  it('drops a rejected token without marking the reset done', () => {
    const state = stateWithoutToken(stateWithToken({ keep: 1 }, 'dead-token'));
    expect(readResetState(state)).toEqual({ token: null, done: false });
    expect(state).toMatchObject({ keep: 1 });
  });

  it('tolerates missing or foreign state', () => {
    for (const state of [null, undefined, 'x', 3, {}, { aquariumResetToken: 5 }]) {
      expect(readResetState(state)).toEqual({ token: null, done: false });
    }
  });
});
