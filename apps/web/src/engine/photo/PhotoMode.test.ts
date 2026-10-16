import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { PhotoPost } from '../effectsSlot';
import { EventBus, type EngineEvents } from '../events';
import { DEFAULT_TANK } from '../tank/dimensions';
import { photoBounds } from './bounds';
import { F_STOP_RANGE } from './lens';
import { FOV_RANGE, type PhotoHost, PhotoMode, type PhotoState } from './PhotoMode';

const CSS = { width: 800, height: 450 };

function setup(options: { dof?: boolean; temporal?: boolean } = {}) {
  const events = new EventBus<EngineEvents>();
  const camera = new PerspectiveCamera(40, CSS.width / CSS.height, 0.05, 50);
  camera.position.set(0, 0.35, 1.6);
  camera.lookAt(0, 0.25, 0);
  const scene = new Scene();
  let pixelRatio = 1;
  const draws: number[] = [];
  const encodedAt: number[] = [];
  const posts: (PhotoPost | null)[] = [];
  const canvas = {
    clientWidth: CSS.width,
    clientHeight: CSS.height,
    toBlob(callback: (blob: Blob | null) => void, type: string) {
      encodedAt.push(pixelRatio);
      queueMicrotask(() => callback(new Blob(['png'], { type })));
    },
  };
  const tier = { dof: options.dof ?? true };
  const host: PhotoHost = {
    camera,
    scene,
    renderer: {
      domElement: canvas as unknown as HTMLCanvasElement,
      getSize: (target: Vector2) => target.set(CSS.width, CSS.height),
      getDrawingBufferSize: (target: Vector2) =>
        target.set(CSS.width * pixelRatio, CSS.height * pixelRatio),
      getPixelRatio: () => pixelRatio,
      setPixelRatio: (value: number) => {
        pixelRatio = value;
      },
    },
    events,
    bounds: photoBounds(DEFAULT_TANK),
    depthOfFieldTier: () => tier.dof,
    temporal: () => options.temporal ?? false,
    maxTextureSize: () => 8192,
    setPost: (post) => posts.push(post),
    draw: () => draws.push(pixelRatio),
  };
  const states: PhotoState[] = [];
  events.on('photo:changed', (state) => states.push(state));
  const photo = new PhotoMode(host);
  return { photo, host, camera, scene, events, states, posts, draws, encodedAt, tier };
}

function uiLayer(): HTMLElement {
  return { style: { visibility: 'visible' }, inert: false } as unknown as HTMLElement;
}

describe('PhotoMode', () => {
  it('takes over the camera where it is and announces it', () => {
    const { photo, camera, states, posts } = setup();
    const before = camera.getWorldDirection(new Vector3());
    photo.enter();
    expect(photo.active).toBe(true);
    expect(photo.pose.position).toEqual({ x: 0, y: 0.35, z: 1.6 });
    expect(camera.getWorldDirection(new Vector3()).distanceTo(before)).toBeLessThan(1e-9);
    expect(states.at(-1)).toMatchObject({
      active: true,
      region: 'room',
      filter: 'natural',
      fov: 40,
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.depthOfField).toBe(false);

    photo.enter();
    expect(posts).toHaveLength(1);
  });

  it('hands the camera back as it was, unpaused and with the UI shown', () => {
    const { photo, camera, states, posts } = setup();
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    const layer = uiLayer();
    photo.enter({ uiLayer: layer });
    photo.turn(1, 0.3);
    photo.move(0.5, 0.2, -0.4);
    photo.setFov(20);
    photo.setSimPaused(true);
    photo.setUiHidden(true);
    expect(layer.style.visibility).toBe('hidden');
    expect(layer.inert).toBe(true);

    photo.exit();
    expect(camera.position.equals(position)).toBe(true);
    expect(camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-9);
    expect(camera.fov).toBe(40);
    expect(photo.simPaused).toBe(false);
    expect(layer.style.visibility).toBe('visible');
    expect(layer.inert).toBe(false);
    expect(posts.at(-1)).toBeNull();
    expect(states.at(-1)).toMatchObject({
      active: false,
      region: null,
      simPaused: false,
      uiHidden: false,
    });
  });

  it('refuses camera calls outside photo mode', () => {
    const { photo } = setup();
    expect(() => photo.turn(0.1, 0)).toThrow(/enter\(\) first/);
    expect(() => photo.move(0, 0, 1)).toThrow(/enter\(\) first/);
    expect(() => photo.focusAt(400, 225)).toThrow(/enter\(\) first/);
    expect(() => photo.setSimPaused(true)).toThrow(/enter\(\) first/);
  });

  it('flies forward where it looks and turns without rolling over the top', () => {
    const { photo, camera } = setup();
    photo.enter();
    photo.setPose({ position: { x: 0, y: 0.6, z: 2 }, yaw: Math.PI / 2, pitch: 0 });
    photo.move(0, 0, 1);
    expect(photo.pose.position.x).toBeCloseTo(-1, 10);
    expect(photo.pose.position.z).toBeCloseTo(2, 10);

    photo.turn(0, 10);
    expect(photo.pose.pitch).toBeLessThan(Math.PI / 2);
    expect(photo.pose.pitch).toBeGreaterThan(Math.PI / 2 - 0.05);
    photo.apply();
    expect(camera.getWorldDirection(new Vector3()).y).toBeGreaterThan(0.99);
    expect(() => photo.turn(Number.NaN, 0)).toThrow(RangeError);
  });

  it('stops at the glass however far it flies at it', () => {
    const { photo, host } = setup();
    photo.enter();
    photo.setPose({ position: { x: 0, y: 0.3, z: 1.6 }, yaw: 0, pitch: 0 });
    photo.move(0, 0, 10);
    expect(photo.pose.position.z).toBe(host.bounds.solid.max.z);
  });

  it('stays in the water when it starts there', () => {
    const { photo, camera, host } = setup();
    camera.position.set(0, 0.25, 0);
    photo.enter();
    expect(photo.state.region).toBe('water');
    photo.move(0, 5, 0);
    expect(photo.pose.position.y).toBe(host.bounds.water.max.y);
  });

  it('clamps the field of view and the lens', () => {
    const { photo } = setup();
    photo.enter();
    photo.setFov(5);
    expect(photo.state.fov).toBe(FOV_RANGE.min);
    photo.setDepthOfField({ fStop: 100, focusDistance: 0.6 });
    expect(photo.state.depthOfField).toMatchObject({ fStop: F_STOP_RANGE.max, focusDistance: 0.6 });
    expect(() => photo.setDepthOfField({ fStop: Number.NaN })).toThrow(RangeError);
  });

  it('asks the post chain for depth of field and says when the tier cannot draw it', () => {
    const { photo, posts, events, states, tier } = setup();
    photo.enter();
    photo.setDepthOfField({ enabled: true });
    expect(posts.at(-1)?.depthOfField).toBe(true);
    expect(states.at(-1)?.depthOfField).toMatchObject({ enabled: true, available: true });

    tier.dof = false;
    events.emit('quality:tier-changed', { from: 'high', to: 'low', reason: 'over-budget' });
    expect(states.at(-1)?.depthOfField).toMatchObject({ enabled: true, available: false });

    const count = posts.length;
    photo.setDepthOfField({ focusDistance: 1 });
    expect(posts).toHaveLength(count);
  });

  it('focuses on the nearest opaque surface under the pointer, by its depth', () => {
    const { photo, scene, camera, states } = setup();
    const glass = new Mesh(new BoxGeometry(1, 1, 0.01), new MeshBasicNodeMaterial());
    glass.material.transparent = true;
    glass.position.set(0, 0.3, 1);
    const rock = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshBasicNodeMaterial());
    rock.name = 'rock';
    rock.position.set(0, 0.3, 0);
    scene.add(glass, rock);
    scene.updateMatrixWorld();
    camera.position.set(0, 0.3, 1.6);
    camera.lookAt(0, 0.3, 0);
    photo.enter();

    const hit = photo.focusAt(CSS.width / 2, CSS.height / 2);
    expect(hit?.objectName).toBe('rock');
    expect(hit?.distance).toBeCloseTo(1.4, 6);
    expect(states.at(-1)?.depthOfField.focusDistance).toBeCloseTo(1.4, 6);
    expect(states.at(-1)?.depthOfField.enabled).toBe(false);

    expect(photo.focusAt(0, 0)).toBeNull();
    expect(photo.state.depthOfField.focusDistance).toBeCloseTo(1.4, 6);
  });

  it('captures at twice the canvas size and puts the canvas back', async () => {
    const { photo, draws, encodedAt } = setup();
    photo.enter();
    const blob = await photo.capture();
    expect(blob.type).toBe('image/png');
    expect(draws).toEqual([2]);
    expect(encodedAt).toEqual([2]);
    expect(photo.look.bokehScale.value).toBeCloseTo(2.5 * (450 / 1080), 6);
  });

  it('lets a temporal resolve settle before capturing', async () => {
    const { photo, draws } = setup({ temporal: true });
    photo.enter();
    await photo.capture({ scale: 1.5 });
    expect(draws.length).toBeGreaterThan(1);
    expect(new Set(draws)).toEqual(new Set([1.5]));
  });

  it('refuses a scale above 2 and leaves the canvas as it was', async () => {
    const { photo, host } = setup();
    photo.enter();
    await expect(photo.capture({ scale: 3 })).rejects.toThrow(/scale/);
    expect(host.renderer.getPixelRatio()).toBe(1);
  });

  it('hides only a layer it was given, and gives back its own style', () => {
    const { photo, states } = setup();
    const layer = uiLayer();
    layer.style.visibility = 'collapse';
    photo.enter({ uiLayer: layer });
    photo.setUiHidden(true);
    photo.setUiHidden(true);
    photo.setUiHidden(false);
    expect(layer.style.visibility).toBe('collapse');
    expect(states.at(-1)?.uiHidden).toBe(false);
  });

  it('measures from the photo eye while active', () => {
    const { photo, camera } = setup();
    expect(photo.viewPosition).toBe(camera.position);
    photo.enter();
    photo.setPose({ position: { x: 1, y: 1, z: 2 }, yaw: 0, pitch: 0 });
    expect(photo.viewPosition.toArray()).toEqual([1, 1, 2]);
  });
});
