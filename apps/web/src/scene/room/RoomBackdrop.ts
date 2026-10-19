import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Shape,
  ShapeGeometry,
  Vector3,
} from 'three/webgpu';
import type { TankDimensions } from '../../engine/tank/dimensions';
import type { Tier } from '../../engine/quality/tiers';
import {
  planRoom,
  roomDetailFor,
  visibleParts,
  type RoomBox,
  type RoomChoice,
  type RoomLayout,
  type RoomMaterial,
  type RoomPreset,
} from './layout';

interface Surface {
  readonly colour: number;
  readonly roughness: number;
  readonly metalness?: number;
}

type Palette = Readonly<Record<RoomMaterial, Surface>>;

const PALETTES: Readonly<Record<RoomPreset, Palette>> = {
  'living-room': {
    wall: { colour: 0xd9cfc0, roughness: 0.95 },
    floor: { colour: 0x8a6a4a, roughness: 0.6 },
    ceiling: { colour: 0xe8e4dc, roughness: 1 },
    wood: { colour: 0x9a7048, roughness: 0.55 },
    darkWood: { colour: 0x4a3326, roughness: 0.6 },
    fabric: { colour: 0x5c6b73, roughness: 1 },
    rug: { colour: 0x8c4f45, roughness: 1 },
    metal: { colour: 0x8a8d90, roughness: 0.4, metalness: 1 },
    frame: { colour: 0xe9e6df, roughness: 0.7 },
    screen: { colour: 0x0c0d10, roughness: 0.2 },
  },
  office: {
    wall: { colour: 0xbfc3c6, roughness: 0.95 },
    floor: { colour: 0x4b4f55, roughness: 0.85 },
    ceiling: { colour: 0xe4e6e8, roughness: 1 },
    wood: { colour: 0xb89a74, roughness: 0.5 },
    darkWood: { colour: 0x3b3835, roughness: 0.6 },
    fabric: { colour: 0x2f3640, roughness: 1 },
    rug: { colour: 0x6d7a86, roughness: 1 },
    metal: { colour: 0x9a9da0, roughness: 0.35, metalness: 1 },
    frame: { colour: 0xf2f2f0, roughness: 0.6 },
    screen: { colour: 0x0c0d10, roughness: 0.2 },
  },
};

const DAYLIGHT_SKY = 0xa9c8e8;

export interface RoomConfig {
  readonly choice: RoomChoice;
  readonly tank: Pick<TankDimensions, 'length' | 'depth' | 'height'>;
  readonly tier: Tier;
  /** Varies the books; the tank's seed once tanks have one. */
  readonly seed?: number;
}

/**
 * The room behind and around the tank, in tank space. Hard parts of one material share one
 * instanced draw, so a full room costs about a dozen draws and the low tier four. Walls face
 * into the room only: an orbit camera that leaves it sees the tank and not the back of a wall.
 */
export class RoomBackdrop {
  readonly group = new Group();
  private layoutNow: RoomLayout | null = null;
  private windowPane: Mesh | null = null;
  private key = '';
  private readonly owned: { dispose(): void }[] = [];

  constructor() {
    this.group.name = 'room-backdrop';
  }

  /** The layout on show, or null when the choice is `none`. */
  get layout(): RoomLayout | null {
    return this.layoutNow;
  }

  /** The sky plane in the window; a weather pass sets its material colour or replaces it. */
  get pane(): Mesh | null {
    return this.windowPane;
  }

  update(config: RoomConfig): void {
    const { length, depth, height } = config.tank;
    const key = [
      config.choice,
      length,
      depth,
      height,
      roomDetailFor(config.tier),
      config.seed ?? 1,
    ].join('|');
    if (key === this.key) return;
    this.key = key;
    this.clear();
    if (config.choice === 'none') return;
    const layout = planRoom(config.choice, config.tank, config.seed);
    this.layoutNow = layout;
    this.build(layout, roomDetailFor(config.tier));
  }

  dispose(): void {
    this.clear();
    this.key = '';
    this.group.removeFromParent();
  }

  private clear(): void {
    for (const resource of this.owned) resource.dispose();
    this.owned.length = 0;
    this.group.clear();
    this.layoutNow = null;
    this.windowPane = null;
  }

  private own<T extends { dispose(): void }>(resource: T): T {
    this.owned.push(resource);
    return resource;
  }

  private build(layout: RoomLayout, detail: ReturnType<typeof roomDetailFor>): void {
    const palette = PALETTES[layout.preset];
    const materials = new Map<RoomMaterial, MeshStandardNodeMaterial>();
    const materialFor = (key: RoomMaterial): MeshStandardNodeMaterial => {
      let material = materials.get(key);
      if (!material) {
        const surface = palette[key];
        material = this.own(
          new MeshStandardNodeMaterial({
            color: surface.colour,
            roughness: surface.roughness,
            metalness: surface.metalness ?? 0,
          }),
        );
        material.name = `room-${key}`;
        materials.set(key, material);
      }
      return material;
    };

    this.buildShell(layout, detail === 'full', materialFor);
    const parts = visibleParts(layout, detail);
    this.buildInstanced(parts.boxes, materialFor);
    if (parts.books.length > 0) this.buildBooks(parts.books);
  }

  private buildShell(
    layout: RoomLayout,
    ceiling: boolean,
    materialFor: (key: RoomMaterial) => Material,
  ): void {
    const { min, max } = layout.shell;
    const width = max[0] - min[0];
    const depth = max[2] - min[2];
    const height = max[1] - min[1];
    const midX = (min[0] + max[0]) / 2;
    const midY = (min[1] + max[1]) / 2;
    const midZ = (min[2] + max[2]) / 2;

    const plane = (
      name: string,
      geometry: BufferGeometry,
      material: Material,
      at: Vector3,
      rotate: (mesh: Mesh) => void,
    ): Mesh => {
      const mesh = new Mesh(this.own(geometry), material);
      mesh.name = name;
      mesh.position.copy(at);
      rotate(mesh);
      this.group.add(mesh);
      return mesh;
    };

    plane(
      'room-floor',
      new PlaneGeometry(width, depth),
      materialFor('floor'),
      new Vector3(midX, min[1], midZ),
      (m) => m.rotateX(-Math.PI / 2),
    );
    plane(
      'room-wall-left',
      new PlaneGeometry(depth, height),
      materialFor('wall'),
      new Vector3(min[0], midY, midZ),
      (m) => m.rotateY(Math.PI / 2),
    );
    plane(
      'room-wall-right',
      new PlaneGeometry(depth, height),
      materialFor('wall'),
      new Vector3(max[0], midY, midZ),
      (m) => m.rotateY(-Math.PI / 2),
    );
    if (ceiling) {
      plane(
        'room-ceiling',
        new PlaneGeometry(width, depth),
        materialFor('ceiling'),
        new Vector3(midX, max[1], midZ),
        (m) => m.rotateX(Math.PI / 2),
      );
    }

    const slot = layout.window;
    const wall = new Shape();
    wall.moveTo(-width / 2, -height / 2);
    wall.lineTo(width / 2, -height / 2);
    wall.lineTo(width / 2, height / 2);
    wall.lineTo(-width / 2, height / 2);
    wall.closePath();
    const hole = new Shape();
    const hx = slot.centre[0] - midX;
    const hy = slot.centre[1] - midY;
    const [ww, wh] = slot.size;
    hole.moveTo(hx - ww / 2, hy - wh / 2);
    hole.lineTo(hx - ww / 2, hy + wh / 2);
    hole.lineTo(hx + ww / 2, hy + wh / 2);
    hole.lineTo(hx + ww / 2, hy - wh / 2);
    hole.closePath();
    wall.holes.push(hole);
    plane(
      'room-wall-back',
      new ShapeGeometry(wall),
      materialFor('wall'),
      new Vector3(midX, midY, min[2]),
      () => undefined,
    );

    const sky = this.own(new MeshBasicNodeMaterial({ color: new Color(DAYLIGHT_SKY) }));
    sky.name = 'room-window-pane';
    this.windowPane = plane(
      'room-window-pane',
      new PlaneGeometry(ww, wh),
      sky,
      new Vector3(slot.centre[0], slot.centre[1], slot.paneZ),
      () => undefined,
    );
  }

  private buildInstanced(
    boxes: readonly RoomBox[],
    materialFor: (key: RoomMaterial) => Material,
  ): void {
    const groups = new Map<string, RoomBox[]>();
    for (const box of boxes) {
      const key = `${box.shape}:${box.material}`;
      const list = groups.get(key);
      if (list) list.push(box);
      else groups.set(key, [box]);
    }
    const geometries = {
      box: this.own(new BoxGeometry(1, 1, 1)),
      cylinder: this.own(new CylinderGeometry(0.5, 0.5, 1, 16)),
    };
    const matrix = new Matrix4();
    const identity = new Quaternion();
    for (const [key, list] of groups) {
      const first = list[0];
      if (!first) continue;
      const mesh = new InstancedMesh(
        geometries[first.shape],
        materialFor(first.material),
        list.length,
      );
      mesh.name = `room-${key}`;
      list.forEach((box, i) => {
        matrix.compose(new Vector3(...box.centre), identity, new Vector3(...box.size));
        mesh.setMatrixAt(i, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
    }
  }

  private buildBooks(books: RoomLayout['books']): void {
    const material = this.own(new MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 }));
    material.name = 'room-books';
    const mesh = new InstancedMesh(this.own(new BoxGeometry(1, 1, 1)), material, books.length);
    mesh.name = 'room-books';
    const matrix = new Matrix4();
    const identity = new Quaternion();
    const colour = new Color();
    books.forEach((book, i) => {
      matrix.compose(new Vector3(...book.centre), identity, new Vector3(...book.size));
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, colour.setHSL(book.hue, 0.45, book.lightness));
    });
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }
}
