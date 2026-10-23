// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useShopAfterCheckout } from './useShopAfterCheckout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({
  home,
  open,
  signedOut = false,
}: {
  home: boolean;
  open: () => void;
  signedOut?: boolean;
}) {
  useShopAfterCheckout(home, open, signedOut);
  return null;
}

describe('opening the shop after Checkout', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  const start = (search: string) => {
    window.history.replaceState(null, '', `/${search}`);
    const open = vi.fn();
    const root = createRoot(document.createElement('div'));
    const render = (home: boolean, signedOut = false) =>
      act(async () => root.render(<Probe home={home} open={open} signedOut={signedOut} />));
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

  it('drops ?payment= from the address when signed out and never opens the shop', async () => {
    window.history.replaceState(null, '', '/?payment=success&tank=a');
    const { open, render, unmount } = start('?payment=success&tank=a');
    await render(true, true);
    expect(window.location.search).toBe('?tank=a');
    await render(true, false);
    expect(open).not.toHaveBeenCalled();
    await unmount();
  });

  it('does nothing without a payment return', async () => {
    const { open, render, unmount } = start('');
    await render(true);
    expect(open).not.toHaveBeenCalled();
    await unmount();
  });
});
