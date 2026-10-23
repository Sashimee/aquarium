import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Shape,
  ShapeGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import { abs, length, materialColor, max, min, positionWorld, smoothstep, vec2 } from 'three/tsl';
import type { WindowSlot } from '../../scene/room/layout';
import type { RoomScenePlan, RoomTierPolicy } from '../../scene/room/roomScene';
import type { TankDimensions } from '../tank/dimensions';

const WALL = { colour: 0xd6cec3, roughness: 0.95 };
const FLOOR = { colour: 0x7a5c40, roughness: 0.6 };
const CEILING = { colour: 0xe6e2da, roughness: 1 };
const FRAME = { colour: 0xe9e6df, roughness: 0.7 };
const DAYLIGHT_SKY = 0xa9c8e8;
const FRAME_BAR = 0.05;
const FRAME_DEPTH = 0.06;
/** The stand overhangs the tank by 2 cm a side, as `Tank` builds it. */
const STAND_OVERHANG = 0.02;
/** How far the floor darkens out from the stand's foot, and how dark it gets there. */
const CONTACT_REACH = 0.18;
const CONTACT_DARKNESS = 0.55;

export interface RoomShell {
  readonly group: Group;
  readonly pane: Mesh | null;
  dispose(): void;
}

/**
 * The procedural walls, floor, ceiling and window of a room, in tank space with the stand on the
 * origin. It costs `shellDrawCalls` draws: the floor carries the stand's contact shadow in its
 * colour, so the shadow needs no draw of its own.
 */
export function buildRoomShell(
  plan: Pick<RoomScenePlan, 'shell' | 'window'>,
  policy: Pick<RoomTierPolicy, 'ceiling' | 'windowFrame'>,
  tank: Pick<TankDimensions, 'length' | 'depth'>,
): RoomShell {
  const group = new Group();
  group.name = 'room-shell';
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(resource: T): T => {
    owned.push(resource);
    return resource;
  };
  const surface = (name: string, spec: { colour: number; roughness: number }) => {
    const material = own(
      new MeshStandardNodeMaterial({ color: spec.colour, roughness: spec.roughness, metalness: 0 }),
    );
    material.name = name;
    return material;
  };

  const { min: lo, max: hi } = plan.shell;
  const width = hi[0] - lo[0];
  const depth = hi[2] - lo[2];
  const height = hi[1] - lo[1];
  const mid = new Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);

  const plane = (name: string, geometry: BufferGeometry, material: Material, at: Vector3) => {
    const mesh = new Mesh(own(geometry), material);
    mesh.name = name;
    mesh.position.copy(at);
    group.add(mesh);
    return mesh;
  };

  const wall = surface('room-wall', WALL);
  const floor = surface('room-floor', FLOOR);
  floor.colorNode = materialColor.mul(contactShadow(tank));
  plane(
    'room-floor',
    new PlaneGeometry(width, depth),
    floor,
    new Vector3(mid.x, lo[1], mid.z),
  ).rotateX(-Math.PI / 2);
  plane(
    'room-wall-left',
    new PlaneGeometry(depth, height),
    wall,
    new Vector3(lo[0], mid.y, mid.z),
  ).rotateY(Math.PI / 2);
  plane(
    'room-wall-right',
    new PlaneGeometry(depth, height),
    wall,
    new Vector3(hi[0], mid.y, mid.z),
  ).rotateY(-Math.PI / 2);
  if (policy.ceiling) {
    plane(
      'room-ceiling',
      new PlaneGeometry(width, depth),
      surface('room-ceiling', CEILING),
      new Vector3(mid.x, hi[1], mid.z),
    ).rotateX(Math.PI / 2);
  }

  const slot = plan.window;
  const back = slot ? wallWithWindow(width, height, slot, mid) : new PlaneGeometry(width, height);
  plane('room-wall-back', back, wall, new Vector3(mid.x, mid.y, lo[2]));

  let pane: Mesh | null = null;
  if (slot) {
    const sky = own(new MeshBasicNodeMaterial({ color: new Color(DAYLIGHT_SKY) }));
    sky.name = 'room-window-pane';
    pane = plane(
      'room-window-pane',
      new PlaneGeometry(slot.size[0], slot.size[1]),
      sky,
      new Vector3(slot.centre[0], slot.centre[1], slot.paneZ),
    );
    if (policy.windowFrame) group.add(own(windowFrame(slot, surface('room-frame', FRAME), own)));
  }

  return {
    group,
    pane,
    dispose() {
      for (const resource of owned) resource.dispose();
      owned.length = 0;
      group.clear();
      group.removeFromParent();
    },
  };
}

function wallWithWindow(width: number, height: number, slot: WindowSlot, mid: Vector3) {
  const outline = new Shape();
  outline.moveTo(-width / 2, -height / 2);
  outline.lineTo(width / 2, -height / 2);
  outline.lineTo(width / 2, height / 2);
  outline.lineTo(-width / 2, height / 2);
  outline.closePath();
  const hole = new Shape();
  const hx = slot.centre[0] - mid.x;
  const hy = slot.centre[1] - mid.y;
  const [w, h] = slot.size;
  hole.moveTo(hx - w / 2, hy - h / 2);
  hole.lineTo(hx - w / 2, hy + h / 2);
  hole.lineTo(hx + w / 2, hy + h / 2);
  hole.lineTo(hx + w / 2, hy - h / 2);
  hole.closePath();
  outline.holes.push(hole);
  return new ShapeGeometry(outline);
}

function windowFrame(
  slot: WindowSlot,
  material: Material,
  own: <T extends { dispose(): void }>(resource: T) => T,
): InstancedMesh {
  const [cx, cy, z] = slot.centre;
  const [w, h] = slot.size;
  const bars: [number, number, number, number][] = [
    [cx, cy + h / 2 + FRAME_BAR / 2, w + 2 * FRAME_BAR, FRAME_BAR],
    [cx, cy - h / 2 - FRAME_BAR / 2, w + 2 * FRAME_BAR, FRAME_BAR],
    [cx - w / 2 - FRAME_BAR / 2, cy, FRAME_BAR, h],
    [cx + w / 2 + FRAME_BAR / 2, cy, FRAME_BAR, h],
    [cx, cy, 0.03, h],
  ];
  const mesh = new InstancedMesh(own(new BoxGeometry(1, 1, 1)), material, bars.length);
  mesh.name = 'room-window-frame';
  const matrix = new Matrix4();
  const identity = new Quaternion();
  bars.forEach(([x, y, sx, sy], i) => {
    matrix.compose(
      new Vector3(x, y, z + FRAME_DEPTH / 2),
      identity,
      new Vector3(sx, sy, FRAME_DEPTH),
    );
    mesh.setMatrixAt(i, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** Soft darkening of the floor around the stand's footprint, 1 away from it. */
function contactShadow(tank: Pick<TankDimensions, 'length' | 'depth'>) {
  const half = vec2(tank.length / 2 + STAND_OVERHANG, tank.depth / 2 + STAND_OVERHANG);
  const q = abs(positionWorld.xz).sub(half);
  const outside = length(max(q, 0)).add(min(max(q.x, q.y), 0));
  return smoothstep(0, CONTACT_REACH, outside).oneMinus().mul(CONTACT_DARKNESS).oneMinus();
}
