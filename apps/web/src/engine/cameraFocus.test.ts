import { describe, expect, it } from 'vitest';
import { CameraRig, type CameraLike, type TankBounds } from '../interaction/camera';
import { depthOfFieldFollowsCamera } from './cameraFocus';

const BOUNDS: TankBounds = {
  halfLength: 0.6,
  halfDepth: 0.25,
  height: 0.5,
  waterTop: 0.47,
  floor: 0.1,
};

const camera: CameraLike = { position: { set: () => undefined }, lookAt: () => undefined };

function rigWithFocusLog() {
  const focus: boolean[] = [];
  const rig = new CameraRig(camera, BOUNDS, {
    reducedMotion: true,
    onModeChange: depthOfFieldFollowsCamera({ setFocusMode: (on) => focus.push(on) }),
  });
  return { rig, focus };
}

describe('depthOfFieldFollowsCamera', () => {
  it('turns focus mode on when the rig follows a fish and off when it leaves', () => {
    const { rig, focus } = rigWithFocusLog();
    rig.focusOn(() => ({ x: 0, y: 0.3, z: 0 }));
    expect(focus).toEqual([true]);
    rig.exit();
    expect(focus).toEqual([true, false]);
  });

  it('turns focus mode off when the rig dives out of focus', () => {
    const { rig, focus } = rigWithFocusLog();
    rig.focusOn(() => ({ x: 0, y: 0.3, z: 0 }));
    rig.dive();
    expect(focus).toEqual([true, false]);
  });

  it('turns focus mode off when the followed fish disappears', () => {
    const { rig, focus } = rigWithFocusLog();
    let alive = true;
    rig.focusOn(() => (alive ? { x: 0, y: 0.3, z: 0 } : null));
    alive = false;
    rig.update(0.016);
    expect(focus).toEqual([true, false]);
  });

  it('keeps focus mode off for orbit and dive', () => {
    const { rig, focus } = rigWithFocusLog();
    rig.dive();
    rig.exit();
    expect(focus).toEqual([false, false]);
  });
});
