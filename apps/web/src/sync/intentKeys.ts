import { ApiRequestError } from '../ui/api';

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * One key per user intent. The key is kept while the outcome is unknown, so a retry of the same
 * intent carries it and the server replays instead of charging twice. A finished intent, whether it
 * worked or was refused, lets the key go: the next press is a new intent.
 */
export class IntentKeys {
  private readonly keys = new Map<string, string>();

  constructor(private readonly make: () => string = newIdempotencyKey) {}

  keyFor(intent: string): string {
    let key = this.keys.get(intent);
    if (key === undefined) {
      key = this.make();
      this.keys.set(intent, key);
    }
    return key;
  }

  settle(intent: string): void {
    this.keys.delete(intent);
  }

  clear(): void {
    this.keys.clear();
  }
}

/** True when the request may or may not have been processed, so a retry must reuse its key. */
export function outcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return (
    error.code === 'network' ||
    error.code === 'timeout' ||
    error.code === 'unexpected_response' ||
    error.code === 'rate_limited' ||
    error.status >= 500
  );
}
