import type { CameraRig, RoomVolume } from './camera';

export interface ShellLayout {
  readonly shell: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
}

export function roomVolume(layout: ShellLayout | null): RoomVolume | null {
  if (!layout) return null;
  const { min, max } = layout.shell;
  return {
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
  };
}

export function syncRoomLimit(rig: CameraRig, layout: ShellLayout | null): void {
  rig.setRoom(roomVolume(layout));
}
