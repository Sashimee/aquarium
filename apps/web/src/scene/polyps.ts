import { uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { SimPolyps } from '@aquarium/sim';

/**
 * Night swell of the small-polyp stony corals (0 = never, 1 = full): Acropora and brain coral feed
 * at night and swell their tissue out of the skeleton, and sit flush by day.
 */
const SWELL_GAIN: Readonly<Record<string, number>> = {
  'acropora-cytherea': 1,
  'acropora-palmata': 1,
  'brain-coral': 0.8,
};

/**
 * Night contraction of the species that stay fully expanded under light for their zooxanthellae
 * (0 = never, 1 = fully drawn in at night). The authored mesh is the daytime shape, so extension 0
 * never changes it. Host anemones draw their tentacles in a little after dark; Euphyllia keeps
 * most of its tentacle length out and only eases back.
 */
const CONTRACTION_GAIN: Readonly<Record<string, number>> = {
  'host-anemone': 0.2,
};

export const EUPHYLLIA_POLYP_GAIN = 0.15;

export function polypGain(assetId: string): number {
  return SWELL_GAIN[assetId] ?? 0;
}

export function contractionGain(assetId: string): number {
  return CONTRACTION_GAIN[assetId] ?? 0;
}

/** Size factor of a contracting species at this extension: 1 in daylight, `1 - gain` at night. */
export function polypSize(gain: number, extension: number): number {
  return 1 - gain * extension;
}

/** GPU twin of `polypSize`, from the shared extension node. */
export function polypSizeNode(extension: Node<'float'>, gain: number): Node<'float'> {
  return extension.mul(-gain).add(1);
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
