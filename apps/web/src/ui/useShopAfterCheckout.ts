import { useEffect, useRef } from 'react';
import { paymentReturn, withoutPaymentReturn } from '../sync/payments';

/**
 * Opens the shop once, on the first time the tank is shown after returning from Checkout. Signed
 * out there is no shop to open, so the address is cleaned instead.
 */
export function useShopAfterCheckout(
  home: boolean,
  openShop: () => void,
  signedOut: boolean,
): void {
  const pending = useRef(paymentReturn(window.location.search) !== null);
  const open = useRef(openShop);
  open.current = openShop;
  useEffect(() => {
    if (!pending.current) return;
    if (signedOut) {
      pending.current = false;
      window.history.replaceState(
        window.history.state,
        '',
        withoutPaymentReturn(
          window.location.pathname + window.location.search + window.location.hash,
        ),
      );
      return;
    }
    if (!home) return;
    pending.current = false;
    open.current();
  }, [home, signedOut]);
}
