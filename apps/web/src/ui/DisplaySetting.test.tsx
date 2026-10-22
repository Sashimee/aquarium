// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisplayPreference, type DisplayStorage } from '../engine/displayPreference';
import { DisplaySetting } from './DisplaySetting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memoryStorage(): DisplayStorage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

describe('DisplaySetting', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const boxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

  it('starts unchecked and writes each choice to the preference', () => {
    const preference = new DisplayPreference(memoryStorage());
    act(() => root.render(<DisplaySetting preference={preference} coarsePointer={false} />));
    expect(boxes().map((b) => b.checked)).toEqual([false, false]);

    act(() => boxes()[0]?.click());
    expect(preference.snapshot()).toEqual({ frameRate: 'display', pixelRatio: 'capped' });
    expect(boxes()[0]?.checked).toBe(true);

    act(() => boxes()[1]?.click());
    expect(preference.snapshot()).toEqual({ frameRate: 'display', pixelRatio: 'device' });

    act(() => boxes()[0]?.click());
    expect(preference.snapshot()).toEqual({ frameRate: 'capped', pixelRatio: 'device' });
  });

  it('follows changes made elsewhere', () => {
    const preference = new DisplayPreference(memoryStorage());
    act(() => root.render(<DisplaySetting preference={preference} coarsePointer={false} />));
    act(() => preference.set({ pixelRatio: 'device' }));
    expect(boxes()[1]?.checked).toBe(true);
  });

  it('states the cost in a note the toggles reference', () => {
    const preference = new DisplayPreference(memoryStorage());
    act(() => root.render(<DisplaySetting preference={preference} coarsePointer={false} />));
    expect(container.querySelector('#display-note')?.textContent).toContain('louder');
    expect(boxes()[0]?.getAttribute('aria-describedby')).toBe('display-note');
  });

  it('renders nothing on a coarse-pointer device', () => {
    const preference = new DisplayPreference(memoryStorage());
    act(() => root.render(<DisplaySetting preference={preference} coarsePointer />));
    expect(container.innerHTML).toBe('');
  });
});
