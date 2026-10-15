export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The build was abandoned', 'AbortError');
}

/** Settles with `work` or rejects as soon as `signal` aborts; `work` itself keeps running. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
