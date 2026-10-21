import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CommunityStreams, frame, type StreamCaps } from './communityStream.ts';

const caps: StreamCaps = { perUser: 2, perIp: 3, total: 4, maxQueue: 3, stallMs: 1000 };

interface Sink {
  stream: Writable;
  chunks: string[];
  drain(): void;
}

function sink(stalled = false): Sink {
  const chunks: string[] = [];
  let release: (() => void)[] = [];
  let holding = stalled;
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      if (holding) release.push(cb);
      else cb();
    },
  });
  return {
    stream,
    chunks,
    drain() {
      holding = false;
      const pending = release;
      release = [];
      for (const cb of pending) cb();
    },
  };
}

const eventsIn = (chunks: string[]) =>
  chunks.flatMap((c) => [...c.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]));

describe('CommunityStreams', () => {
  it('formats a frame as a named server-sent event', () => {
    expect(frame('feed', { a: 1 })).toBe('event: feed\ndata: {"a":1}\n\n');
  });

  it('refuses past the per-user, per-IP and total caps and frees a slot on close', async () => {
    const streams = new CommunityStreams({ ...caps, total: 6 });
    const open = (user: string | null, ip: string) => streams.open(user, ip, sink().stream);
    const first = open('u1', '1.1.1.1');
    expect(typeof first).toBe('object');
    open('u1', '1.1.1.2');
    expect(open('u1', '1.1.1.3')).toBe('user');
    for (let i = 0; i < caps.perIp; i++) open(null, '2.2.2.2');
    expect(open(null, '2.2.2.2')).toBe('ip');
    expect(streams.size).toBe(5);
    expect(typeof open('u2', '3.3.3.3')).toBe('object');
    expect(open('u3', '4.4.4.4')).toBe('total');
    if (typeof first === 'string') throw new Error('first stream was refused');
    const closed = new Promise((resolve) => first.stream.once('close', resolve));
    first.stream.destroy();
    await closed;
    expect(streams.size).toBe(5);
    expect(typeof open('u3', '4.4.4.4')).toBe('object');
  });

  it('delivers the first frame, then events in order', () => {
    const streams = new CommunityStreams(caps);
    const s = sink();
    const client = streams.open(null, '1.1.1.1', s.stream);
    if (typeof client === 'string') throw new Error('refused');
    streams.broadcast('feed', { n: 1 });
    expect(s.chunks).toEqual([]);
    streams.start(client, frame('state', {}));
    streams.broadcast('death', { n: 2 });
    expect(eventsIn(s.chunks)).toEqual(['state', 'feed', 'death']);
    expect(s.chunks[0]).toBe('retry: 5000\n\n');
  });

  it('keeps only the newest snapshot for a reader that cannot keep up', () => {
    const streams = new CommunityStreams({ ...caps, maxQueue: 10 });
    const s = sink(true);
    const client = streams.open(null, '1.1.1.1', s.stream);
    if (typeof client === 'string') throw new Error('refused');
    streams.start(client, frame('state', { v: 0 }));
    for (let v = 1; v <= 50; v++) streams.broadcast('state', { v });
    s.drain();
    const states = s.chunks.filter((c) => c.startsWith('event: state'));
    expect(states).toHaveLength(2);
    expect(states[1]).toContain('"v":50');
    expect(s.stream.destroyed).toBe(false);
  });

  it('drops a reader whose queue of events overflows', async () => {
    const streams = new CommunityStreams(caps);
    const s = sink(true);
    const client = streams.open(null, '1.1.1.1', s.stream);
    if (typeof client === 'string') throw new Error('refused');
    streams.start(client, frame('state', {}));
    for (let n = 0; n < caps.maxQueue; n++) streams.broadcast('feed', { n });
    expect(s.stream.destroyed).toBe(false);
    const closed = new Promise((resolve) => s.stream.once('close', resolve));
    streams.broadcast('feed', { n: 99 });
    expect(s.stream.destroyed).toBe(true);
    await closed;
    expect(streams.size).toBe(0);
  });

  it('drops a reader that stays blocked past the stall limit and only that one', () => {
    let now = 0;
    const streams = new CommunityStreams(caps, () => now);
    const slow = sink(true);
    const quick = sink();
    for (const [s, ip] of [
      [slow, '1.1.1.1'],
      [quick, '2.2.2.2'],
    ] as const) {
      const client = streams.open(null, ip, s.stream);
      if (typeof client === 'string') throw new Error('refused');
      streams.start(client, frame('state', {}));
    }
    now = 999;
    streams.sweep();
    expect(slow.stream.destroyed).toBe(false);
    now = 1001;
    streams.sweep();
    expect(slow.stream.destroyed).toBe(true);
    expect(quick.stream.destroyed).toBe(false);
  });

  it('does not count a reader that caught up as stalled', () => {
    let now = 0;
    const streams = new CommunityStreams(caps, () => now);
    const s = sink(true);
    const client = streams.open(null, '1.1.1.1', s.stream);
    if (typeof client === 'string') throw new Error('refused');
    streams.start(client, frame('state', {}));
    s.drain();
    now = 5000;
    streams.sweep();
    expect(s.stream.destroyed).toBe(false);
  });

  it('ends every stream on closeAll', async () => {
    const streams = new CommunityStreams(caps);
    const s = sink();
    const client = streams.open(null, '1.1.1.1', s.stream);
    if (typeof client === 'string') throw new Error('refused');
    streams.start(client, frame('state', {}));
    const closed = new Promise((resolve) => s.stream.once('close', resolve));
    streams.closeAll();
    await closed;
    expect(streams.size).toBe(0);
  });
});
