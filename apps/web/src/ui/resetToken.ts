const TOKEN_KEY = 'aquariumResetToken';
const DONE_KEY = 'aquariumResetDone';

export interface ResetHistoryState {
  token: string | null;
  done: boolean;
}

function asRecord(state: unknown): Record<string, unknown> {
  return typeof state === 'object' && state !== null
    ? { ...(state as Record<string, unknown>) }
    : {};
}

export function readResetState(state: unknown): ResetHistoryState {
  const record = asRecord(state);
  const token = record[TOKEN_KEY];
  return {
    token: typeof token === 'string' && token ? token : null,
    done: record[DONE_KEY] === true,
  };
}

export function stateWithToken(state: unknown, token: string): Record<string, unknown> {
  return { ...asRecord(state), [TOKEN_KEY]: token, [DONE_KEY]: false };
}

export function stateWithResetDone(state: unknown): Record<string, unknown> {
  return { ...asRecord(state), [TOKEN_KEY]: null, [DONE_KEY]: true };
}

/** Drops only `token`; every other query parameter and the hash stay. */
export function withoutTokenParam(location: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  const params = new URLSearchParams(location.search);
  params.delete('token');
  const query = params.toString();
  return location.pathname + (query ? `?${query}` : '') + location.hash;
}
