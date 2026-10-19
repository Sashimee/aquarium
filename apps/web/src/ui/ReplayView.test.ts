import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ReplayLine } from '../sync/replay';
import { ReplayPanel, type ReplayPanelLoad, type ReplayPanelProps } from './ReplayView';

const SINCE = '2026-10-18T10:00:00.000Z';
const lines: ReplayLine[] = [
  { id: 'a', at: '2026-10-18T11:00:00.000Z', text: 'Water changed.', tone: 'good' },
  { id: 'b', at: '2026-10-18T13:00:00.000Z', text: 'Bubbles fell ill.', tone: 'warn' },
];

function render(load: ReplayPanelLoad, shown = 0, playing = false) {
  const props: ReplayPanelProps = {
    load,
    since: SINCE,
    playback: { shown, playing, mode: 'simulate' },
    speed: 2,
    onSkip: vi.fn(),
    onToggle: vi.fn(),
    onScrub: vi.fn(),
    onSpeed: vi.fn(),
    onRetry: vi.fn(),
  };
  return renderToStaticMarkup(createElement(ReplayPanel, props));
}

describe('ReplayPanel', () => {
  it('always offers the skip control', () => {
    const loads: ReplayPanelLoad[] = [
      { status: 'loading' },
      { status: 'error', message: 'nope' },
      { status: 'ready', lines: [], truncated: false },
      { status: 'ready', lines, truncated: false },
    ];
    for (const load of loads) expect(render(load)).toContain('Skip replay');
  });

  it('reveals only the events played so far', () => {
    const html = render({ status: 'ready', lines, truncated: false }, 1, true);
    expect(html).toContain('Water changed.');
    expect(html).not.toContain('Bubbles fell ill.');
    expect(html).toContain('1 hour in');
    expect(html).toContain('Pause');
  });

  it('says so for an empty timeline and offers no playback', () => {
    const html = render({ status: 'ready', lines: [], truncated: false });
    expect(html).toContain('A quiet stretch');
    expect(html).not.toContain('type="range"');
  });

  it('shows an error with a retry', () => {
    const html = render({ status: 'error', message: 'You are offline.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('You are offline.');
    expect(html).toContain('Try again');
  });

  it('notes a truncated timeline', () => {
    expect(render({ status: 'ready', lines, truncated: true }, 2)).toContain('Only the first part');
  });

  it('tells simulate and crossfade apart', () => {
    const base: ReplayPanelLoad = { status: 'ready', lines, truncated: false };
    expect(render(base)).toContain('fast-forward');
    const crossfade: ReplayPanelProps = {
      load: base,
      since: SINCE,
      playback: { shown: 0, playing: false, mode: 'crossfade' },
      speed: 1,
      onSkip: vi.fn(),
      onToggle: vi.fn(),
      onScrub: vi.fn(),
      onSpeed: vi.fn(),
      onRetry: vi.fn(),
    };
    expect(renderToStaticMarkup(createElement(ReplayPanel, crossfade))).toContain(
      'fades between snapshots',
    );
  });
});
