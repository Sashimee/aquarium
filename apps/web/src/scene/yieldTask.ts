/**
 * Resolves in a later task so queued frames and input run first. A message channel instead of
 * `setTimeout(0)`: timers are clamped to 4 ms when nested and to 1 s in background tabs.
 */
export function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}
