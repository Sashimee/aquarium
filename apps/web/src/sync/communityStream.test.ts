import { describe, expect, it } from 'vitest';
import { createOpenStream, SseParser, type SseFrame } from './communityStream';

describe('SseParser', () => {
  it('parses frames split across chunks and CRLF line ends', () => {
    const parser = new SseParser();
    expect(parser.push('event: viewers\r\ndata: {"vie')).toEqual([]);
    expect(parser.push('wers":2}\r\n\r\nevent: feed\ndata: {}\n')).toEqual([
      { event: 'viewers', data: '{"viewers":2}' },
    ]);
    expect(parser.push('\n')).toEqual([{ event: 'feed', data: '{}' }]);
  });

  it('skips comments and joins multi-line data', () => {
    const parser = new SseParser();
    expect(parser.push(': ping\n\ndata: a\ndata: b\n\n')).toEqual([
      { event: 'message', data: 'a\nb' },
    ]);
  });

  it('waits for the line feed after a trailing carriage return', () => {
    const parser = new SseParser();
    expect(parser.push('data: x\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual([{ event: 'message', data: 'x' }]);
  });
});

function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('createOpenStream', () => {
  const signal = new AbortController().signal;

  it('delivers frames and resolves when the server closes', async () => {
    const frames: SseFrame[] = [];
    const open = createOpenStream(() =>
      Promise.resolve(
        streamOf(['event: state\ndata: {"a":1}\n\n', ': hb\n\nevent: viewers\ndata: {}\n\n']),
      ),
    );
    await open({ signal, onFrame: (f) => frames.push(f) });
    expect(frames.map((f) => f.event)).toEqual(['state', 'viewers']);
  });

  it('turns a 429 into an error carrying Retry-After', async () => {
    const open = createOpenStream(() =>
      Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '10' } })),
    );
    await expect(open({ signal, onFrame: () => undefined })).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 10,
    });
  });

  it('reports a 503 as busy and a network failure as network', async () => {
    const busy = createOpenStream(() =>
      Promise.resolve(new Response('{}', { status: 503, headers: { 'retry-after': '30' } })),
    );
    await expect(busy({ signal, onFrame: () => undefined })).rejects.toMatchObject({
      status: 503,
      retryAfterSeconds: 30,
    });
    const down = createOpenStream(() => Promise.reject(new TypeError('failed to fetch')));
    await expect(down({ signal, onFrame: () => undefined })).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('rethrows the abort when the caller cancels', async () => {
    const controller = new AbortController();
    const open = createOpenStream((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
      });
    });
    const pending = open({ signal: controller.signal, onFrame: () => undefined });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
