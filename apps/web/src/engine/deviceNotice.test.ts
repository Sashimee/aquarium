// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showDeviceNotice } from './deviceNotice';

function stacks(): NodeListOf<HTMLElement> {
  return document.body.querySelectorAll<HTMLElement>('.engine-notices');
}

function messages(): string[] {
  return [...document.body.querySelectorAll('[role="alert"] span')].map((s) => s.textContent);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('showDeviceNotice', () => {
  it('stacks a second notice under the first instead of over it', () => {
    showDeviceNotice(document.body, 'Drawing with WebGL 2.');
    showDeviceNotice(document.body, 'The graphics device was lost.');
    expect(stacks()).toHaveLength(1);
    expect(stacks()[0]?.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(messages()).toEqual(['Drawing with WebGL 2.', 'The graphics device was lost.']);
  });

  it('removes the column with its last notice and builds a fresh one for the next', () => {
    const first = showDeviceNotice(document.body, 'one');
    const second = showDeviceNotice(document.body, 'two');
    first();
    expect(stacks()).toHaveLength(1);
    expect(messages()).toEqual(['two']);
    second();
    expect(stacks()).toHaveLength(0);
    showDeviceNotice(document.body, 'three');
    expect(stacks()).toHaveLength(1);
    expect(messages()).toEqual(['three']);
  });

  it('dismisses only the clicked notice and runs its action', () => {
    const run = vi.fn();
    showDeviceNotice(document.body, 'keep');
    showDeviceNotice(document.body, 'reload', { label: 'Reload', run });
    document.body.querySelectorAll('button')[1]?.click();
    expect(run).toHaveBeenCalledOnce();
    expect(messages()).toEqual(['keep']);
  });
});
