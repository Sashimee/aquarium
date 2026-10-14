import { describe, expect, it } from 'vitest';
import { stackedBottom } from './statsOverlay';

describe('stackedBottom', () => {
  it('sits at the safe-area edge when there is no report', () => {
    expect(stackedBottom(800, null)).toBe('max(0.75rem, env(safe-area-inset-bottom))');
  });

  it('sits 8 px above the top of the report', () => {
    expect(stackedBottom(800, 700)).toBe('108px');
    expect(stackedBottom(800, 420.5)).toBe('387.5px');
  });

  it('sits just above the bottom edge for a report collapsed to nothing', () => {
    expect(stackedBottom(800, 800)).toBe('8px');
  });
});
