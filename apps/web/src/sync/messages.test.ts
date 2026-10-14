import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../ui/api';
import { describeSyncError } from './messages';

describe('describeSyncError', () => {
  it('tells a timeout apart from a network failure', () => {
    const timeout = describeSyncError(new ApiRequestError(0, 'timeout', 'raw'));
    const network = describeSyncError(new ApiRequestError(0, 'network', 'offline'));
    expect(timeout).toMatch(/did not answer/);
    expect(timeout).not.toBe(network);
  });
});
