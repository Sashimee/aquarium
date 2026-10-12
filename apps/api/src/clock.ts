export interface Clock {
  now(): number;
  advance(ms: number): void;
}

export function createClock(): Clock {
  let offsetMs = 0;
  return {
    now: () => Date.now() + offsetMs,
    advance(ms) {
      offsetMs += ms;
    },
  };
}
