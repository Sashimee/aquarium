import { describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  Group,
  Matrix4,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  Texture,
} from 'three/webgpu';
import { TANK_DIMENSIONS } from '../../engine/tank/dimensions';
import { RoomProps, type PropSource } from './RoomProps';
import { planRoomScene, type PropCatalog } from './roomScene';

const catalog: PropCatalog = () => ({
  bounds: { min: [-0.2, 0, -0.2], max: [0.2, 0.5, 0.2] },
  lods: [{ triangles: 100 }, { triangles: 60 }, { triangles: 30 }],
});

function fakeSource(primitivesPerProp = 2) {
  const loaded: { geometry: BoxGeometry; material: MeshBasicNodeMaterial; texture: Texture }[] = [];
  const source: PropSource = {
    load: vi.fn(async () => {
      const root = new Group();
      for (let i = 0; i < primitivesPerProp; i++) {
        const geometry = new BoxGeometry(1, 1, 1);
        const material = new MeshBasicNodeMaterial();
        const texture = new Texture();
        material.map = texture;
        loaded.push({ geometry, material, texture });
        root.add(new Mesh(geometry, material));
      }
      return root;
    }),
  };
  return { source, loaded };
}

const sushi = (tier: 'medium' | 'high' = 'high') =>
  planRoomScene({ roomId: 'room-sushi', tank: TANK_DIMENSIONS.standard, tier, catalog });

describe('RoomProps', () => {
  it('instances a prop placed several times into one draw per primitive', async () => {
    const plan = sushi();
    const { source } = fakeSource(1);
    const props = new RoomProps();
    await props.show(plan, source);
    const chairs = props.group.children.filter(
      (c) => c.name === 'room-prop-polyhaven-bar-chair-round-01',
    );
    expect(chairs).toHaveLength(1);
    expect((chairs[0] as InstancedMesh).count).toBe(4);
    expect(props.drawCalls).toBe(new Set(plan.props.map((p) => p.asset)).size);
  });

  it('loads each asset once at the LOD the plan chose', async () => {
    const { source } = fakeSource();
    await new RoomProps().show(sushi('medium'), source);
    const calls = vi.mocked(source.load).mock.calls;
    expect(calls.map((c) => c[0]).sort()).toEqual([...new Set(calls.map((c) => c[0]))].sort());
    expect(calls.every((c) => c[1] === 2)).toBe(true);
  });

  it('places each instance at its planned position', async () => {
    const plan = sushi();
    const { source } = fakeSource(1);
    const props = new RoomProps();
    await props.show(plan, source);
    const table = props.group.children.find((c) => c.name.endsWith('round-wooden-table-02')) as
      InstancedMesh | undefined;
    const matrix = new Matrix4();
    table?.getMatrixAt(0, matrix);
    const placed = plan.props.find((p) => p.asset.endsWith('round-wooden-table-02'));
    expect(matrix.elements[12]).toBeCloseTo(placed?.position[0] ?? NaN, 5);
    expect(matrix.elements[14]).toBeCloseTo(placed?.position[2] ?? NaN, 5);
  });

  it('shows nothing for a room with no props, as on the low tier', async () => {
    const plan = planRoomScene({
      roomId: 'room-living',
      tank: TANK_DIMENSIONS.standard,
      tier: 'low',
      catalog,
    });
    const { source } = fakeSource();
    const props = new RoomProps();
    await props.show(plan, source);
    expect(props.group.children).toHaveLength(0);
    expect(source.load).not.toHaveBeenCalled();
  });

  it('frees geometry, materials and textures on dispose', async () => {
    const { source, loaded } = fakeSource();
    const props = new RoomProps();
    await props.show(sushi(), source);
    const geometry = vi.spyOn(loaded[0]?.geometry as BoxGeometry, 'dispose');
    const material = vi.spyOn(loaded[0]?.material as MeshBasicNodeMaterial, 'dispose');
    const texture = vi.spyOn(loaded[0]?.texture as Texture, 'dispose');
    props.dispose();
    expect(geometry).toHaveBeenCalled();
    expect(material).toHaveBeenCalled();
    expect(texture).toHaveBeenCalled();
    expect(props.group.children).toHaveLength(0);
  });

  it('replaces the previous room when shown again', async () => {
    const { source } = fakeSource(1);
    const props = new RoomProps();
    await props.show(sushi(), source);
    const first = props.group.children.length;
    await props.show(
      planRoomScene({ roomId: 'room-zen', tank: TANK_DIMENSIONS.standard, tier: 'high', catalog }),
      source,
    );
    expect(first).toBe(3);
    expect(props.group.children.map((c) => c.name)).not.toEqual([]);
    expect(props.group.children.every((c) => !c.name.includes('bar-chair'))).toBe(true);
  });

  it('discards a load that a newer one overtook', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: PropSource = {
      load: async () => {
        await gate;
        const root = new Group();
        root.add(new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial()));
        return root;
      },
    };
    const props = new RoomProps();
    const stale = props.show(sushi(), slow);
    await props.show(
      planRoomScene({
        roomId: 'room-living',
        tank: TANK_DIMENSIONS.standard,
        tier: 'low',
        catalog,
      }),
      slow,
    );
    release();
    await stale;
    expect(props.group.children).toHaveLength(0);
  });

  it('rejects when the load is aborted', async () => {
    const controller = new AbortController();
    const never: PropSource = { load: () => new Promise(() => undefined) };
    const pending = new RoomProps().show(sushi(), never, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('frees what a load resolves with after the abort', async () => {
    const controller = new AbortController();
    const parts = {
      geometry: new BoxGeometry(),
      material: new MeshBasicNodeMaterial(),
      texture: new Texture(),
    };
    parts.material.map = parts.texture;
    let finish: (root: Group) => void = () => undefined;
    const late: PropSource = { load: () => new Promise<Group>((resolve) => (finish = resolve)) };
    const spies = [
      vi.spyOn(parts.geometry, 'dispose'),
      vi.spyOn(parts.material, 'dispose'),
      vi.spyOn(parts.texture, 'dispose'),
    ];
    const plan = planRoomScene({
      roomId: 'room-zen',
      tank: TANK_DIMENSIONS.standard,
      tier: 'high',
      catalog,
    });
    const pending = new RoomProps().show(
      { ...plan, props: plan.props.slice(0, 1) },
      late,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    const root = new Group();
    root.add(new Mesh(parts.geometry, parts.material));
    finish(root);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const spy of spies) expect(spy).toHaveBeenCalled();
  });

  it('frees the props that loaded when another one fails', async () => {
    const ok = { geometry: new BoxGeometry(), material: new MeshBasicNodeMaterial() };
    const spies = [vi.spyOn(ok.geometry, 'dispose'), vi.spyOn(ok.material, 'dispose')];
    const source: PropSource = {
      load: async (asset) => {
        if (asset.endsWith('bar-chair-round-01')) throw new Error('chair 404');
        const root = new Group();
        root.add(new Mesh(ok.geometry, ok.material));
        return root;
      },
    };
    const props = new RoomProps();
    await expect(props.show(sushi(), source)).rejects.toThrow('chair 404');
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const spy of spies) expect(spy).toHaveBeenCalled();
    expect(props.group.children).toHaveLength(0);
  });

  it('logs a prop that fails after the show was aborted, but not the abort itself', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const controller = new AbortController();
    const rejects: ((cause: Error) => void)[] = [];
    const failing: PropSource = {
      load: () => new Promise<Group>((_resolve, reject) => rejects.push(reject)),
    };
    const pending = new RoomProps().show(sushi(), failing, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    rejects[0]?.(abort);
    rejects[1]?.(new Error('chair 404'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[1]).toEqual(new Error('chair 404'));
    debug.mockRestore();
  });

  it('keeps quiet about a failure in a show that a newer one replaced', async () => {
    let fail: (cause: Error) => void = () => undefined;
    const failing: PropSource = {
      load: () => new Promise<Group>((_resolve, reject) => (fail = reject)),
    };
    const props = new RoomProps();
    const stale = props.show(sushi(), failing);
    await props.show(
      planRoomScene({
        roomId: 'room-living',
        tank: TANK_DIMENSIONS.standard,
        tier: 'low',
        catalog,
      }),
      failing,
    );
    fail(new Error('late failure'));
    await expect(stale).resolves.toBeUndefined();
  });
});
