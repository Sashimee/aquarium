import { Matrix3, type Node } from 'three/webgpu';
import { max, pow, uniform, vec4 } from 'three/tsl';
import { GREY, photoGrade, type PhotoFilter } from './grade';
import {
  clampFocusDistance,
  DEFAULT_F_STOP,
  DEFAULT_FOCUS_DISTANCE,
  lensBlur,
  REFERENCE_LINES,
} from './lens';

/**
 * Photo mode's lens and grade as uniforms, so moving the focus, the aperture or the filter never
 * rebuilds a pipeline; only turning depth of field on or off does.
 */
export class PhotoLook {
  readonly focusDistance = uniform(DEFAULT_FOCUS_DISTANCE);
  readonly focalRange = uniform(0);
  readonly bokehScale = uniform(0);
  readonly gradeMatrix = uniform(new Matrix3());
  readonly contrast = uniform(1);

  constructor() {
    this.setLens(DEFAULT_FOCUS_DISTANCE, DEFAULT_F_STOP, REFERENCE_LINES);
    this.setFilter('natural');
  }

  /** `lines` is the drawing buffer's height in pixels. */
  setLens(focusDistance: number, fStop: number, lines: number): void {
    const blur = lensBlur(focusDistance, fStop, lines);
    this.focusDistance.value = clampFocusDistance(focusDistance);
    this.focalRange.value = blur.focalRange;
    this.bokehScale.value = blur.bokehScale;
  }

  setFilter(filter: PhotoFilter): void {
    const { matrix, contrast } = photoGrade(filter);
    this.gradeMatrix.value.set(...matrix);
    this.contrast.value = contrast;
  }

  /** `colour` graded in linear light, ahead of tone mapping. */
  grade(colour: Node<'vec4'>): Node<'vec4'> {
    const rgb = this.gradeMatrix.mul(colour.rgb);
    return vec4(pow(max(rgb, 0).div(GREY), this.contrast).mul(GREY), colour.a);
  }
}
