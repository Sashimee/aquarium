import { describe, expect, it } from 'vitest';
import { SaveStatusMerge } from './saveStatus';

function setup() {
  const seen: { status: string; message: string | null; source: string }[] = [];
  const merge = new SaveStatusMerge((status, message, source) =>
    seen.push({ status, message, source }),
  );
  return { seen, layout: merge.reporter('layout'), background: merge.reporter('background') };
}

describe('SaveStatusMerge', () => {
  it('reports a lone saver as it is', () => {
    const { seen, layout } = setup();
    layout('saving', null);
    layout('saved', null);
    expect(seen.map((s) => s.status)).toEqual(['saving', 'saved']);
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
});
