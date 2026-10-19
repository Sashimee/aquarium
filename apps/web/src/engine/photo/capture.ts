export const MAX_CAPTURE_SCALE = 2;
/** About 16.8 MP: every target of the post chain at this size stays within a phone's memory. */
export const MAX_CAPTURE_PIXELS = 4096 * 4096;
/** What WebGPU guarantees and WebGL 2 devices in practice reach; a lower device limit wins. */
export const MAX_CAPTURE_EDGE = 8192;

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The largest 2D texture side a three.js backend's device allows: the WebGPU device's limits or
 * the WebGL context's `MAX_TEXTURE_SIZE`, else `MAX_CAPTURE_EDGE`. three exposes neither in its
 * types, so both are read by shape.
 */
export function deviceTextureLimit(backend: unknown): number {
  if (typeof backend !== 'object' || backend === null) return MAX_CAPTURE_EDGE;
  if ('device' in backend) {
    const { device } = backend;
    if (typeof device === 'object' && device !== null && 'limits' in device) {
      const { limits } = device;
      if (typeof limits === 'object' && limits !== null && 'maxTextureDimension2D' in limits) {
        return positive(limits.maxTextureDimension2D) ?? MAX_CAPTURE_EDGE;
      }
    }
  }
  if ('gl' in backend) {
    const { gl } = backend;
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      return positive(gl.getParameter(gl.MAX_TEXTURE_SIZE)) ?? MAX_CAPTURE_EDGE;
    }
  }
  return MAX_CAPTURE_EDGE;
}

export interface CaptureSize {
  /** Renderer pixel ratio for the capture: drawing-buffer pixels per CSS pixel. */
  readonly pixelRatio: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The capture of a `cssWidth` x `cssHeight` canvas at `scale` times its CSS size, shrunk to fit
 * `maxEdge` per side and `MAX_CAPTURE_PIXELS` in all, keeping the aspect.
 */
export function captureSize(
  cssWidth: number,
  cssHeight: number,
  scale: number,
  maxEdge: number = MAX_CAPTURE_EDGE,
): CaptureSize {
  if (!(cssWidth >= 1 && cssHeight >= 1)) {
    throw new RangeError(`capture: the canvas has no area (${cssWidth} x ${cssHeight} CSS px)`);
  }
  if (!(scale > 0 && scale <= MAX_CAPTURE_SCALE)) {
    throw new RangeError(`capture: scale must be in (0, ${MAX_CAPTURE_SCALE}], got ${scale}`);
  }
  if (!(maxEdge >= 1)) throw new RangeError(`capture: maxEdge must be >= 1, got ${maxEdge}`);
  const edge = Math.min(maxEdge, MAX_CAPTURE_EDGE);
  const fitEdge = edge / Math.max(cssWidth, cssHeight);
  const fitArea = Math.sqrt(MAX_CAPTURE_PIXELS / (cssWidth * cssHeight));
  const pixelRatio = Math.min(scale, fitEdge, fitArea);
  return {
    pixelRatio,
    width: Math.max(1, Math.floor(cssWidth * pixelRatio)),
    height: Math.max(1, Math.floor(cssHeight * pixelRatio)),
  };
}
