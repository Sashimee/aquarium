import type { Writable } from 'node:stream';

export interface StreamCaps {
  perUser: number;
  perIp: number;
  total: number;
  maxQueue: number;
  stallMs: number;
}

export type Refusal = 'user' | 'ip' | 'total';

export interface StreamClient {
  readonly id: number;
  readonly userId: string | null;
  readonly ip: string;
  readonly stream: Writable;
  closed: boolean;
}

interface Slot extends StreamClient {
  ready: boolean;
  queue: { event: string; text: string }[];
  blockedSince: number | null;
}

export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Events a slow reader has not drained are queued, a newer `state` or `viewers` replaces an older
// queued one (each is a full snapshot), and a reader whose queue overflows or whose socket stays
// full for stallMs is cut loose: EventSource reconnects and the first frame resyncs it.
const COALESCED = new Set(['state', 'viewers']);

export class CommunityStreams {
  private readonly slots = new Map<number, Slot>();
  private nextId = 1;

  constructor(
    private readonly caps: StreamCaps,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.slots.size;
  }

  refusal(userId: string | null, ip: string): Refusal | null {
    if (this.slots.size >= this.caps.total) return 'total';
    let sameIp = 0;
    let sameUser = 0;
    for (const slot of this.slots.values()) {
      if (slot.ip === ip) sameIp++;
      if (userId !== null && slot.userId === userId) sameUser++;
    }
    if (userId !== null && sameUser >= this.caps.perUser) return 'user';
    if (sameIp >= this.caps.perIp) return 'ip';
    return null;
  }

  open(userId: string | null, ip: string, stream: Writable): StreamClient | Refusal {
    const refused = this.refusal(userId, ip);
    if (refused) return refused;
    const slot: Slot = {
      id: this.nextId++,
      userId,
      ip,
      stream,
      closed: false,
      ready: false,
      queue: [],
      blockedSince: null,
    };
    this.slots.set(slot.id, slot);
    const release = () => {
      slot.closed = true;
      slot.queue = [];
      this.slots.delete(slot.id);
    };
    stream.once('close', release);
    stream.on('error', () => stream.destroy());
    stream.on('drain', () => this.flush(slot));
    return slot;
  }

  start(client: StreamClient, first: string): void {
    const slot = this.slots.get(client.id);
    if (!slot || slot.closed) return;
    slot.ready = true;
    this.write(slot, 'retry: 5000\n\n');
    this.write(slot, first);
    this.flush(slot);
  }

  broadcast(event: string, data: unknown): void {
    const text = frame(event, data);
    for (const slot of this.slots.values()) this.deliver(slot, event, text);
  }

  sweep(): void {
    const at = this.now();
    for (const slot of [...this.slots.values()]) {
      if (slot.blockedSince !== null && at - slot.blockedSince > this.caps.stallMs) {
        slot.stream.destroy();
      }
    }
  }

  closeAll(): void {
    for (const slot of [...this.slots.values()]) {
      slot.ready = false;
      slot.stream.end();
    }
  }

  private deliver(slot: Slot, event: string, text: string): void {
    if (slot.closed) return;
    if (slot.ready && slot.queue.length === 0 && !slot.stream.writableNeedDrain) {
      this.write(slot, text);
      return;
    }
    if (COALESCED.has(event)) slot.queue = slot.queue.filter((q) => q.event !== event);
    if (slot.queue.length >= this.caps.maxQueue) {
      slot.stream.destroy();
      return;
    }
    slot.queue.push({ event, text });
  }

  private write(slot: Slot, text: string): void {
    if (slot.closed) return;
    if (!slot.stream.write(text) && slot.blockedSince === null) slot.blockedSince = this.now();
  }

  private flush(slot: Slot): void {
    if (slot.closed || !slot.ready) return;
    while (slot.queue.length > 0 && !slot.stream.writableNeedDrain) {
      const next = slot.queue.shift();
      if (next) this.write(slot, next.text);
    }
    if (!slot.stream.writableNeedDrain && slot.queue.length === 0) slot.blockedSince = null;
  }
}
