import type { BackendKind, EngineStats } from './events';
import type { Tier } from './quality/tiers';

/** What the readout needs from the engine, so it can be computed without a GPU. */
export interface ReadoutSource {
  readonly backend: BackendKind;
  readonly quality: { readonly adaptive: boolean };
  readonly renderer: {
    getPixelRatio(): number;
    readonly domElement: { readonly width: number; readonly height: number };
  };
}

export interface StatsReadout {
  backend: BackendKind;
  tier: Tier;
  adaptive: boolean;
  fps: string;
  frame: string;
  gpu: string;
  dpr: string;
  pixelRatio: string;
  canvas: string;
  draws: number;
  triangles: number;
}

export function readStats(
  source: ReadoutSource,
  stats: EngineStats,
  devicePixelRatio: number,
): StatsReadout {
  const { width, height } = source.renderer.domElement;
  return {
    backend: source.backend,
    tier: stats.tier,
    adaptive: source.quality.adaptive,
    fps: stats.fps.toFixed(1),
    frame: stats.frameMs.toFixed(2),
    gpu: stats.gpuMs === null ? 'n/a' : stats.gpuMs.toFixed(2),
    dpr: devicePixelRatio.toFixed(2),
    pixelRatio: source.renderer.getPixelRatio().toFixed(2),
    canvas: `${width}x${height}`,
    draws: stats.drawCalls,
    triangles: stats.triangles,
  };
}

export function formatReadout(r: StatsReadout): string {
  return [
    `${r.backend}  ${r.tier}  adaptive ${r.adaptive ? 'on' : 'off'}`,
    `fps ${r.fps}  frame ${r.frame} ms`,
    `gpu ${r.gpu} ms`,
    `dpr ${r.dpr}  render ${r.pixelRatio}`,
    `canvas ${r.canvas}`,
    `draws ${r.draws}  tris ${r.triangles.toLocaleString('en-US')}`,
  ].join('\n');
}
