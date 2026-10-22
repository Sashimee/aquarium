import { useEffect, useRef } from 'react';
import { paymentReturn } from '../sync/payments';

/** Opens the shop once, on the first time the tank is shown after returning from Checkout. */
export function useShopAfterCheckout(home: boolean, openShop: () => void): void {
  const pending = useRef(paymentReturn(window.location.search) !== null);
  const open = useRef(openShop);
  open.current = openShop;
  useEffect(() => {
    if (!pending.current || !home) return;
    pending.current = false;
    open.current();
  }, [home]);
}
