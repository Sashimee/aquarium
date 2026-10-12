export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** sfc32. Integer-only, so the sequence is bit-identical on every JS engine. */
export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError(`Rng seed must be a safe integer, got ${seed}`);
    }
    const mix = splitmix32(seed);
    this.a = mix();
    this.b = mix();
    this.c = mix();
    this.d = mix();
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  static fromState(state: RngState): Rng {
    const rng = new Rng(0);
    rng.a = state.a >>> 0;
    rng.b = state.b >>> 0;
    rng.c = state.c >>> 0;
    rng.d = state.d >>> 0;
    return rng;
  }

  state(): RngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }

  nextUint32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform in [-1, 1). */
  signed(): number {
    return this.next() * 2 - 1;
  }

  /** Standard normal (Box–Muller, one draw per call). */
  gaussian(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
