import { COMMUNITY_STREAM_PATH } from '@aquarium/shared';
import { ApiRequestError } from '../ui/api';

export interface SseFrame {
  event: string;
  data: string;
}

/** Incremental text/event-stream parser: chunks may split lines, frames and CRLF pairs anywhere. */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      // A lone trailing CR may be the first half of a CRLF, so it waits for the next chunk.
      const match = /\r\n|\n|\r(?!$)/.exec(this.buffer);
      if (!match) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (line === '') {
        if (this.data.length > 0) {
          frames.push({ event: this.event || 'message', data: this.data.join('\n') });
        }
        this.event = '';
        this.data = [];
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
      }
    }
    return frames;
  }
}

export interface OpenStreamOptions {
  signal: AbortSignal;
  onFrame(frame: SseFrame): void;
}

export type OpenStream = (options: OpenStreamOptions) => Promise<void>;

function refusal(res: Response): ApiRequestError {
  const header = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  const retryAfter = Number.isFinite(header) && header > 0 ? header : null;
  const busy = res.status === 429 || res.status === 503;
  return new ApiRequestError(
    res.status,
    busy ? 'rate_limited' : 'unexpected_response',
    busy
      ? 'The community tank has too many viewers right now.'
      : `The community tank stream answered ${res.status}.`,
    {},
    retryAfter,
  );
}

/**
 * Resolves when the server closes the stream and rejects when it cannot be opened or breaks; an
 * abort through `signal` rejects with the abort reason, which callers tell apart by `signal.aborted`.
 * Built on fetch rather than EventSource because EventSource hides the status and Retry-After of a refusal.
 */
export function createOpenStream(fetcher: typeof fetch = (i, init) => fetch(i, init)): OpenStream {
  return async ({ signal, onFrame }) => {
    let res: Response;
    try {
      res = await fetcher(COMMUNITY_STREAM_PATH, {
        credentials: 'same-origin',
        headers: { accept: 'text/event-stream' },
        signal,
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new ApiRequestError(
        0,
        'network',
        'Could not reach the community tank. Check your connection.',
      );
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw refusal(res);
    }
    if (!res.body) {
      throw new ApiRequestError(0, 'unexpected_response', 'The community tank stream was empty.');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        for (const frame of parser.push(decoder.decode(next.value, { stream: true }))) {
          onFrame(frame);
        }
      }
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new ApiRequestError(0, 'network', 'The community tank connection dropped.');
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  };
}
