import { uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { SimPolyps } from '@aquarium/sim';

/**
 * How much of its size a species' polyps change between day and night (0 = never, 1 = fully
 * retracted by day). Small-polyp stony corals (Acropora, brain coral) feed at night and pull their
 * tissue in under light; Euphyllia keeps its tentacles out for its zooxanthellae but fans them
 * further in the dark; a host anemone stays expanded for its symbionts and its fish.
 */
const POLYP_GAIN: Readonly<Record<string, number>> = {
  'acropora-cytherea': 1,
  'acropora-palmata': 1,
  'brain-coral': 0.8,
  'host-anemone': 0.25,
};

export const EUPHYLLIA_POLYP_GAIN = 0.5;

export function polypGain(assetId: string): number {
  return POLYP_GAIN[assetId] ?? 0;
}

/** Size factor of a polyp with this gain at this extension: 1 fully out, `1 - gain` retracted. */
export function polypSize(gain: number, extension: number): number {
  return 1 - gain * (1 - extension);
}

/** GPU twin of `polypSize`, from the shared extension node. */
export function polypSizeNode(extension: Node<'float'>, gain: number): Node<'float'> {
  return extension.oneMinus().mul(-gain).add(1);
}

export interface PolypSource {
  onPolyps(listener: (extension: number, event: SimPolyps) => void): () => void;
}

/**
 * The tank's polyp extension as one shared GPU uniform. Every polyp-bearing material reads
 * `node`; an update only writes a number, so nothing allocates per frame. Events from an earlier
 * world (lower epoch) or an earlier snapshot of this one (lower tick) are dropped.
 */
export class PolypSignal {
  readonly node = uniform(0);
  private epoch = -1;
  private tick = -1;
  private unbind: (() => void) | null = null;

  get extension(): number {
    return this.node.value;
  }

  accept(extension: number, event: Pick<SimPolyps, 'epoch' | 'tick'>): void {
    if (event.epoch < this.epoch || (event.epoch === this.epoch && event.tick < this.tick)) return;
    if (!Number.isFinite(extension)) return;
    this.epoch = event.epoch;
    this.tick = event.tick;
    this.node.value = Math.min(1, Math.max(0, extension));
  }

  /** Follows `source` until the next `bind` or `dispose`; a new tank's client replaces the old subscription. */
  bind(source: PolypSource): void {
    this.unbind?.();
    this.epoch = -1;
    this.tick = -1;
    this.unbind = source.onPolyps((extension, event) => this.accept(extension, event));
  }

  dispose(): void {
    this.unbind?.();
    this.unbind = null;
  }
}
