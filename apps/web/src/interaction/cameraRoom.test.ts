import { describe, expect, it } from 'vitest';
import { CameraRig, orbitDistanceFor, tankBounds, type CameraLike, type Vec3 } from './camera';
import { framingScale, TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { planRoom } from '../scene/room/layout';
import { roomVolume } from './roomLimit';

type Size = keyof typeof TANK_DIMENSIONS;
type Preset = 'living-room' | 'office';

const sizes = Object.keys(TANK_DIMENSIONS) as Size[];
const presets: Preset[] = ['living-room', 'office'];

function fakeCamera() {
  const camera = {
    pos: { x: 0, y: 0, z: 0 } as Vec3,
    position: {
      set(x: number, y: number, z: number) {
        camera.pos = { x, y, z };
      },
    },
    lookAt() {},
  };
  return camera satisfies CameraLike & { pos: Vec3 };
}

function roomRig(size: Size, preset: Preset) {
  const d = TANK_DIMENSIONS[size];
  const { shell } = planRoom(preset, d);
  const room = {
    min: { x: shell.min[0], y: shell.min[1], z: shell.min[2] },
    max: { x: shell.max[0], y: shell.max[1], z: shell.max[2] },
  };
  const cam = fakeCamera();
  const rig = new CameraRig(cam, tankBounds(d), {
    orbitDistance: orbitDistanceFor(framingScale(d)),
  });
  rig.setRoom(room);
  return { rig, cam, room, d };
}

function settle(rig: CameraRig) {
  for (let t = 0; t < 5; t += 1 / 60) rig.update(1 / 60);
}

const outsideGlass = (p: Vec3, d: { length: number; depth: number; height: number }) =>
  Math.abs(p.x) >= d.length / 2 - 1e-9 ||
  Math.abs(p.z) >= d.depth / 2 - 1e-9 ||
  p.y <= 0 ||
  p.y >= d.height - 1e-9;

const inRoom = (p: Vec3, room: { min: Vec3; max: Vec3 }) =>
  p.x > room.min.x &&
  p.x < room.max.x &&
  p.y > room.min.y &&
  p.y < room.max.y &&
  p.z > room.min.z &&
  p.z < room.max.z;

describe('CameraRig room limit', () => {
  it('keeps the eye inside the room at every limit of azimuth, polar angle and distance', () => {
    for (const size of sizes) {
      for (const preset of presets) {
        const { rig, cam, room, d } = roomRig(size, preset);
        for (let yaw = -Math.PI; yaw <= Math.PI; yaw += Math.PI / 12) {
          for (const pitch of [-0.15, 0.1, 0.7, 1.35]) {
            for (const distance of [0.01, 1.6, 100]) {
              rig.setOrbit(yaw, pitch, distance);
              settle(rig);
              const label = `${size} ${preset} ${yaw} ${pitch} ${distance}`;
              expect(inRoom(cam.pos, room), label).toBe(true);
              expect(outsideGlass(cam.pos, d), label).toBe(true);
            }
          }
        }
      }
    }
  });

  it('keeps the eye outside the glass when swinging round from behind the tank', () => {
    for (const size of sizes) {
      const { rig, cam, d } = roomRig(size, 'living-room');
      rig.setOrbit(Math.PI, 0.1, 1);
      settle(rig);
      expect(outsideGlass(cam.pos, d), size).toBe(true);
    }
  });

  it('keeps the pitch when turning the yaw alone clears the back wall', () => {
    const { rig, cam, d } = roomRig('standard', 'living-room');
    const elevation = () => Math.atan2(cam.pos.y - d.height / 2, Math.hypot(cam.pos.x, cam.pos.z));
    rig.setOrbit(0.4, 0.7, 1);
    settle(rig);
    const before = elevation();
    rig.setOrbit(Math.PI * 0.95, 0.7, 1);
    settle(rig);
    expect(elevation()).toBeCloseTo(before, 3);
  });

  it('never crosses the tank when a room is picked while viewing from behind', () => {
    const { rig, cam, d } = roomRig('standard', 'living-room');
    rig.setRoom(null);
    rig.setOrbit(Math.PI, 0.1, 2);
    settle(rig);
    rig.setRoom(roomRig('standard', 'living-room').room);
    for (let t = 0; t < 3; t += 1 / 60) {
      rig.update(1 / 60);
      expect(outsideGlass(cam.pos, d)).toBe(true);
    }
  });

  it('leaves the front view untouched and allows a wide zoom out', () => {
    const { rig, cam, d } = roomRig('standard', 'office');
    rig.setOrbit(0, 0.1, 3);
    settle(rig);
    expect(Math.hypot(cam.pos.x, cam.pos.y - d.height / 2, cam.pos.z)).toBeCloseTo(3, 6);
    expect(cam.pos.z).toBeGreaterThan(0);
  });

  it('keeps a focus eye inside the room when the fish swims against the back wall', () => {
    const { rig, cam, room, d } = roomRig('standard', 'living-room');
    rig.setOrbit(Math.PI, 0, 1);
    rig.focusOn(() => ({ x: 0, y: d.height / 2, z: -d.depth / 2 + 0.02 }));
    settle(rig);
    expect(inRoom(cam.pos, room)).toBe(true);
  });

  it('applies no limit once the room is lifted', () => {
    const { rig, cam } = roomRig('standard', 'living-room');
    rig.setRoom(null);
    rig.setOrbit(Math.PI, 0.1, 3);
    settle(rig);
    expect(cam.pos.z).toBeLessThan(-2);
  });
});

describe('roomVolume', () => {
  it('maps a layout shell to a volume and a missing layout to no limit', () => {
    expect(roomVolume(null)).toBeNull();
    const layout = planRoom('office', TANK_DIMENSIONS.standard);
    const volume = roomVolume(layout);
    expect(volume?.min.z).toBe(layout.shell.min[2]);
    expect(volume?.max.y).toBe(layout.shell.max[1]);
  });
});
