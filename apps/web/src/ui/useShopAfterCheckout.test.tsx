// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useShopAfterCheckout } from './useShopAfterCheckout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ home, open }: { home: boolean; open: () => void }) {
  useShopAfterCheckout(home, open);
  return null;
}

describe('opening the shop after Checkout', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  const start = (search: string) => {
    window.history.replaceState(null, '', `/${search}`);
    const open = vi.fn();
    const root = createRoot(document.createElement('div'));
    const render = (home: boolean) =>
      act(async () => root.render(<Probe home={home} open={open} />));
    return { open, render, unmount: () => act(() => root.unmount()) };
  };

  it('opens once and not again when the user leaves and comes back', async () => {
    const { open, render, unmount } = start('?payment=success');
    await render(true);
    expect(open).toHaveBeenCalledTimes(1);
    await render(false);
    await render(true);
    await render(false);
    await render(true);
    expect(open).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('waits for the tank view when the page starts elsewhere', async () => {
    const { open, render, unmount } = start('?payment=cancelled');
    await render(false);
    expect(open).not.toHaveBeenCalled();
    await render(true);
    expect(open).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('does nothing without a payment return', async () => {
    const { open, render, unmount } = start('');
    await render(true);
    expect(open).not.toHaveBeenCalled();
    await unmount();
  });
});
