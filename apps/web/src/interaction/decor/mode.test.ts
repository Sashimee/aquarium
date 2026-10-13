import type { DecorItem } from '@aquarium/shared';
import type { DecorCollider } from '@aquarium/sim';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Engine } from '../../engine/Engine';
import { EventBus, type EngineEvents } from '../../engine/events';
import { DEFAULT_TANK } from '../../engine/tank/dimensions';
import type { CatalogEntry } from '../../scene/assets';
import type { DecorViewState, InteractionEvents } from '../events';
import { SavedDecor } from './binding';
import catalog from '../../../public/assets/index.json';
import { item, must } from './fixtures';
import { DecorMode } from './mode';
import { VACATION_FEEDER_ASSET_ID } from './spec';
import { FeederLayer } from './feederLayer';
import { DecorWorld, type DecorScenePort } from './world';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(layout: DecorItem[], biome: 'freshwater' | 'reef' = 'freshwater') {
  const bus = new EventBus<InteractionEvents>();
  const camera = new PerspectiveCamera(50, 1, 0.01, 10);
  camera.position.set(0, 2, 0.0001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  let frame: (dt: number) => void = () => undefined;
  const engine = {
    camera,
    tank: { dimensions: DEFAULT_TANK },
    renderer: { domElement: { clientWidth: 1000, clientHeight: 1000 } },
    events: new EventBus<EngineEvents>(),
    onFrame: (cb: (dt: number) => void) => {
      frame = cb;
      return () => undefined;
    },
  } as unknown as Engine;

  const hard: DecorItem[][] = [];
  const scene: DecorScenePort = {
    biome,
    presetHardDecor: layout,
    fixedDecor: [],
    catalogEntries: () => catalog.assets as unknown as CatalogEntry[],
    groundHeight: () => 0.06,
    setHardDecor: (items) => {
      hard.push([...items]);
      return Promise.resolve();
    },
    moveHardDecor: () => undefined,
  };
  const world = new DecorWorld(scene, bus, new FeederLayer());
  const saved = new SavedDecor(bus, () => undefined);
  saved.attach(world);

  const layouts: { tankId: string; layout: DecorItem[] }[] = [];
  const colliders: (readonly DecorCollider[])[] = [];
  const states: DecorViewState[] = [];
  const modes: boolean[] = [];
  bus.on('decor:layout', (e) => layouts.push(e));
  bus.on('decor:colliders', (e) => colliders.push(e.colliders));
  bus.on('decor:state', (e) => states.push(e));
  bus.on('decor:mode-changed', (e) => modes.push(e.active));

  let reduced = false;
  let now = 0;
  const mode = new DecorMode({
    engine,
    world,
    saved,
    interaction: bus,
    reducedMotion: () => reduced,
    now: () => now,
  });
  const runFrames = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) frame(1 / 60);
  };
  return {
    bus,
    mode,
    world,
    hard,
    layouts,
    colliders,
    states,
    modes,
    runFrames,
    setReduced: (v: boolean) => (reduced = v),
    tick: (ms: number) => (now += ms),
    load: (tankId: string, decorLayout: DecorItem[] = []) =>
      bus.emit('tank:loaded', { tankId, biome, fish: [], decorLayout }),
    last: () => must(states.at(-1)),
  };
}

const at = (x: number, z: number): [number, number] => {
  const camera = new PerspectiveCamera(50, 1, 0.01, 10);
  camera.position.set(0, 2, 0.0001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const p = new Vector3(x, 0.12, z).project(camera);
  return [((p.x + 1) / 2) * 1000, ((1 - p.y) / 2) * 1000];
};

describe('DecorMode', () => {
  it('announces itself and lists what can be placed', () => {
    const h = harness([item('boulder-01', 0, 0)]);
    expect(h.mode.start()).toBe(true);
    expect(h.modes).toEqual([true]);
    expect(h.last().active).toBe(true);
    expect(h.last().palette.map((p) => p.assetId)).toContain(VACATION_FEEDER_ASSET_ID);
    expect(h.last().pieces).toEqual([{ id: 'p1', label: 'Boulder' }]);
    expect(h.last().persisted).toBe(false);
  });

  it('offers only the pieces the tank biome allows', () => {
    const fresh = harness([], 'freshwater');
    fresh.mode.start();
    const freshIds = fresh.last().palette.map((p) => p.assetId);
    expect(freshIds).toContain('driftwood-branch');
    expect(freshIds).not.toContain('reef-arch');

    const reef = harness([], 'reef');
    reef.mode.start();
    const reefIds = reef.last().palette.map((p) => p.assetId);
    expect(reefIds).toContain('reef-arch');
    expect(reefIds).not.toContain('driftwood-branch');
  });

  it('removes saved wrong-biome pieces on load and says so', async () => {
    const h = harness([], 'freshwater');
    h.load('t1', [item('driftwood-branch', 0, 0), item('reef-arch', 0.3, 0)]);
    await settle();
    h.mode.start();
    expect(h.last().pieces.map((p) => p.label)).toEqual(['Driftwood branch']);
    expect(h.last().problem).toMatch(/1 saved piece does not fit this tank/);
  });

  it('says why a second vacation feeder is refused', () => {
    const h = harness([]);
    h.mode.start();
    h.bus.emit('decor:command', { type: 'add', assetId: VACATION_FEEDER_ASSET_ID });
    h.bus.emit('decor:command', { type: 'add', assetId: VACATION_FEEDER_ASSET_ID });
    expect(h.last().hasFeeder).toBe(true);
    expect(h.last().pieces.filter((p) => p.label === 'Vacation feeder')).toHaveLength(1);
    expect(h.last().problem).toMatch(/one vacation feeder/i);
  });

  it('refuses to edit a scene of another biome than the tank', () => {
    const h = harness([], 'freshwater');
    h.bus.emit('tank:loaded', {
      tankId: 't',
      biome: 'reef',
      fish: [],
      decorLayout: [],
    });
    expect(h.mode.start()).toBe(false);
    expect(h.mode.active).toBe(false);
    expect(h.last().problem).toMatch(/different kind of tank/);
  });

  it('adds a piece, lets it fall, and saves its resting layout once', async () => {
    const h = harness([]);
    h.load('t1');
    h.mode.start();
    h.bus.emit('decor:command', { type: 'add', assetId: 'boulder-01' });
    await settle();
    expect(h.last().pieces).toHaveLength(1);
    const early = must(h.layouts.at(-1));
    expect(early.tankId).toBe('t1');
    const restY = must(early.layout[0]).position[1];
    h.runFrames(3);
    const settled = must(h.layouts.at(-1));
    expect(must(settled.layout[0]).position[1]).toBeCloseTo(restY, 3);
    expect(must(h.colliders.at(-1))).toHaveLength(1);
  });

  it('does not save for the demo tank', async () => {
    const h = harness([]);
    h.mode.start();
    h.bus.emit('decor:command', { type: 'add', assetId: 'boulder-01' });
    await settle();
    expect(h.layouts).toEqual([]);
    expect(h.last().persisted).toBe(false);
  });

  it('drags a piece with the pointer and saves where it was dropped', () => {
    const h = harness([item('boulder-01', 0, 0)]);
    h.load('t1');
    h.mode.start();
    h.mode.pointerDown(...at(0, 0));
    expect(h.mode.claimsDrag).toBe(true);
    h.mode.pointerMove(...at(0.3, 0.1));
    h.mode.pointerUp();
    h.runFrames(3);
    const saved = must(h.layouts.at(-1));
    const [x, , z] = must(saved.layout[0]).position;
    expect(x).toBeGreaterThan(0.2);
    expect(z).toBeGreaterThan(0.05);
    expect(h.mode.claimsDrag).toBe(false);
  });

  it('puts a piece back when it is dropped onto another and explains why', () => {
    const h = harness([item('boulder-01', -0.3, 0), item('boulder-01', 0.3, 0)]);
    h.load('t1');
    h.mode.start();
    h.mode.pointerDown(...at(-0.3, 0));
    h.mode.pointerMove(...at(0.28, 0));
    h.mode.pointerUp();
    expect(h.last().problem).toMatch(/overlap/i);
    expect(must(h.world.pieces[0]).item.position[0]).toBeCloseTo(-0.3, 6);
  });

  it('orbits instead when the pointer goes down on empty water', () => {
    const h = harness([item('boulder-01', 0.4, 0)]);
    h.mode.start();
    h.mode.pointerDown(...at(-0.3, 0));
    expect(h.mode.claimsDrag).toBe(false);
  });

  it('selects on tap and clears the selection on empty water', () => {
    const h = harness([item('boulder-01', 0, 0)]);
    h.mode.start();
    h.mode.tap(...at(0, 0));
    expect(h.last().selectedId).toBe('p1');
    h.mode.tap(...at(0.5, 0.2));
    expect(h.last().selectedId).toBeNull();
  });

  it('rotates, nudges and removes the selected piece, saving each time', () => {
    const h = harness([item('boulder-01', 0, 0)]);
    h.load('t1');
    h.mode.start();
    h.bus.emit('decor:command', { type: 'rotate', id: 'p1', radians: 0.5 });
    expect(must(must(h.layouts.at(-1)).layout[0]).rotationY).toBeCloseTo(0.5, 6);
    h.bus.emit('decor:command', { type: 'nudge', id: 'p1', dx: 0.02, dz: 0 });
    expect(must(must(h.layouts.at(-1)).layout[0]).position[0]).toBeCloseTo(0.02, 6);
  });

  it('allows one vacation feeder and puts it in the saved layout', async () => {
    const h = harness([]);
    h.load('t1');
    h.mode.start();
    h.bus.emit('decor:command', { type: 'add', assetId: VACATION_FEEDER_ASSET_ID });
    await settle();
    h.bus.emit('decor:command', { type: 'add', assetId: VACATION_FEEDER_ASSET_ID });
    await settle();
    expect(h.last().hasFeeder).toBe(true);
    expect(h.last().pieces).toHaveLength(1);
    expect(h.last().problem).toMatch(/one vacation feeder/i);
    expect(must(h.layouts.at(-1)).layout.map((i) => i.assetId)).toEqual([VACATION_FEEDER_ASSET_ID]);
  });

  it('skips the fall when the player prefers reduced motion', async () => {
    const h = harness([]);
    h.load('t1');
    h.setReduced(true);
    h.mode.start();
    h.bus.emit('decor:command', { type: 'add', assetId: 'boulder-01' });
    await settle();
    const y = must(must(h.world.pieces[0]).item.position[1]);
    h.runFrames(0.1);
    expect(must(h.world.pieces[0]).item.position[1]).toBe(y);
    expect(y).toBeLessThan(0.06);
  });

  it('settles everything and saves when decorating ends mid-fall', async () => {
    const h = harness([]);
    h.load('t1');
    h.mode.start();
    h.bus.emit('decor:command', { type: 'add', assetId: 'boulder-01' });
    await settle();
    h.mode.stop();
    expect(h.modes).toEqual([true, false]);
    expect(h.mode.active).toBe(false);
    expect(h.last().active).toBe(false);
    const final = must(must(h.layouts.at(-1)).layout[0]).position[1];
    expect(final).toBeLessThan(0.06);
  });

  it('stops listening to commands once decorating ends', async () => {
    const h = harness([]);
    h.load('t1');
    h.mode.start();
    h.mode.stop();
    const before = h.layouts.length;
    h.bus.emit('decor:command', { type: 'add', assetId: 'boulder-01' });
    await settle();
    expect(h.layouts.length).toBe(before);
  });

  it('leaves decorate mode when another tank loads and never saves into it', async () => {
    const h = harness([]);
    h.load('t1');
    h.mode.start();
    h.bus.emit('decor:command', { type: 'add', assetId: 'boulder-01' });
    await settle();
    const savedForA = h.layouts.length;
    h.load('t2');
    expect(h.mode.active).toBe(false);
    expect(h.modes).toEqual([true, false]);
    h.mode.stop();
    h.bus.emit('decor:command', { type: 'add', assetId: 'boulder-01' });
    await settle();
    expect(h.layouts).toHaveLength(savedForA);
    expect(h.layouts.every((l) => l.tankId === 't1')).toBe(true);
  });

  it('leaves decorate mode when the tank is unloaded on sign-out', async () => {
    const h = harness([]);
    h.load('t1');
    h.mode.start();
    h.bus.emit('decor:command', { type: 'add', assetId: 'boulder-01' });
    await settle();
    const savedForA = h.layouts.length;
    h.bus.emit('tank:unloaded', { tankId: 't1', reason: 'switch' });
    expect(h.mode.active).toBe(false);
    expect(h.modes).toEqual([true, false]);
    expect(h.layouts).toHaveLength(savedForA);
  });

  it('thins out collider updates while a piece is being dragged', () => {
    const h = harness([item('boulder-01', 0, 0)]);
    h.mode.start();
    const base = h.colliders.length;
    h.mode.pointerDown(...at(0, 0));
    for (let i = 0; i < 10; i++) {
      h.tick(10);
      h.mode.pointerMove(...at(0.02 * (i + 1), 0));
    }
    expect(h.colliders.length - base).toBeLessThanOrEqual(2);
    h.mode.pointerUp();
    expect(h.colliders.length - base).toBeGreaterThanOrEqual(1);
  });
});
