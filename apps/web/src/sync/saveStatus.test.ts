import { describe, expect, it } from 'vitest';
import { SaveStatusMerge } from './saveStatus';

function setup() {
  const seen: { status: string; message: string | null; source: string }[] = [];
  const reports: { source: string; status: string }[] = [];
  const merge = new SaveStatusMerge((status, message, source, reported) => {
    seen.push({ status, message, source });
    reports.push(reported);
  });
  return {
    seen,
    reports,
    layout: merge.reporter('layout'),
    background: merge.reporter('background'),
  };
}

describe('SaveStatusMerge', () => {
  it('reports a lone saver as it is', () => {
    const { seen, layout } = setup();
    layout('saving', null);
    layout('saved', null);
    expect(seen.map((s) => s.status)).toEqual(['saving', 'saved']);
  });

  it('reports which saver spoke and what it said, whatever status is shown', () => {
    const { seen, reports, layout, background } = setup();
    layout('error', 'nope');
    background('saved', null);
    expect(seen.at(-1)?.status).toBe('error');
    expect(reports).toEqual([
      { source: 'layout', status: 'error' },
      { source: 'background', status: 'saved' },
    ]);
  });

  it('lets an error outlast the other saver succeeding', () => {
    const { seen, layout, background } = setup();
    layout('error', 'nope');
    background('saving', null);
    background('saved', null);
    expect(seen.at(-1)).toEqual({ status: 'error', message: 'nope', source: 'layout' });
  });

  it('clears the error once the failed saver succeeds', () => {
    const { seen, layout, background } = setup();
    background('error', 'down');
    layout('saved', null);
    background('saving', null);
    background('saved', null);
    expect(seen.at(-1)?.status).toBe('saved');
  });

  it('shows saving while either saver is busy and idle after both reset', () => {
    const { seen, layout, background } = setup();
    layout('saved', null);
    background('saving', null);
    expect(seen.at(-1)?.status).toBe('saving');
    layout('idle', null);
    background('idle', null);
    expect(seen.at(-1)).toMatchObject({ status: 'idle', message: null });
  });

  it('keeps the first failure message when a second saver also errors', () => {
    const { seen, layout, background } = setup();
    layout('error', 'layout down');
    background('error', 'background down');
    expect(seen.at(-1)).toEqual({ status: 'error', message: 'layout down', source: 'layout' });
  });

  it('keeps the first failure message when the first saver reports again', () => {
    const { seen, layout, background } = setup();
    layout('error', 'first');
    background('error', 'second');
    layout('error', 'first again');
    expect(seen.at(-1)).toEqual({ status: 'error', message: 'first again', source: 'layout' });
  });

  it('falls back to the remaining failure once the shown one recovers', () => {
    const { seen, layout, background } = setup();
    layout('error', 'layout down');
    background('error', 'background down');
    layout('saved', null);
    expect(seen.at(-1)).toEqual({
      status: 'error',
      message: 'background down',
      source: 'background',
    });
  });
});
