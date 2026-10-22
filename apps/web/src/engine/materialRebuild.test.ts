import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { FishInstanceData, INSTANCE_STRIDE } from '../fish/instances';
import { FishMaterial } from '../fish/material';
import { renderProfile } from '../fish/profiles';
import { SWIM_MODES } from '../fish/swim';
import { createInertRenderer } from './inertRenderer';
import { MaterialRebuild } from './materialRebuild';

function swimmer() {
  const map = new DataTexture(new Uint8Array(4), 1, 1);
  const instances = new FishInstanceData(4, INSTANCE_STRIDE);
  const material = new FishMaterial({
    source: new MeshStandardMaterial({ map }),
    assetId: 'angelfish',
    profile: renderProfile('angelfish'),
    locomotion: { kind: 'swim', mode: SWIM_MODES.carangiform },
    zMin: -0.05,
    zMax: 0.05,
    instances,
    lighting: { lightDirection: uniform(new Vector3(0, 1, 0)), light: vec3(1) },
    mouth: false,
    displays: false,
  });
  return { material, map, instances };
}

/** Counts the dispose events three's render objects release themselves on. */
function released(material: { addEventListener(type: 'dispose', listener: () => void): void }) {
  const count = { value: 0 };
  material.addEventListener('dispose', () => count.value++);
  return count;
}

describe('MaterialRebuild', () => {
  it('does nothing until a rebuild is requested', () => {
    const scene = new Group();
    const material = new MeshStandardNodeMaterial();
    scene.add(new Mesh(new BoxGeometry(), material));
    const count = released(material);
    expect(new MaterialRebuild().flush(scene, 0)).toBe(0);
    expect(count.value).toBe(0);
  });

  it('releases each material in the scene once, the hidden ones and arrays too', () => {
    const scene = new Group();
    const shared = new MeshStandardNodeMaterial();
    const other = new MeshStandardNodeMaterial();
    const hidden = new Mesh(new BoxGeometry(), other);
    hidden.visible = false;
    scene.add(new Mesh(new BoxGeometry(), shared), new Mesh(new BoxGeometry(), [shared, other]));
    scene.add(hidden);
    const counts = [released(shared), released(other)];

    const rebuild = new MaterialRebuild();
    expect(rebuild.request()).toBe(true);
    expect(rebuild.flush(scene, 0)).toBe(2);
    expect(counts.map((c) => c.value)).toEqual([1, 1]);
    expect(rebuild.flush(scene, 0)).toBe(0);
  });

  it('makes three release the render objects of the scene and shadow passes', async () => {
    const { renderer, renderObjects, nextFrame } = await createInertRenderer();
    const scene = new Scene();
    const light = new DirectionalLight();
    light.castShadow = true;
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(light, mesh);
    const camera = new PerspectiveCamera();
    camera.position.z = 5;
    const meshPasses = () => [...renderObjects()].filter((r) => r.object === mesh);

    renderer.render(scene, camera);
    const drawn = meshPasses();
    expect(drawn.map((r) => r.camera)).toEqual([camera, light.shadow.camera]);

    const rebuild = new MaterialRebuild();
    rebuild.request();
    rebuild.flush(scene, 0);
    expect(meshPasses()).toEqual([]);

    nextFrame();
    renderer.render(scene, camera);
    const redrawn = meshPasses();
    expect(redrawn).toHaveLength(2);
    for (const renderObject of redrawn) expect(drawn).not.toContain(renderObject);
  });

  it('keeps the fish on their own swim material, its textures and instance data', () => {
    const { material, map, instances } = swimmer();
    const bend = material.deformed;
    const shadowBend = material.castShadowPositionNode;
    const mesh = new InstancedMesh(new BoxGeometry(), material, 4);
    const scene = new Group();
    scene.add(mesh);
    const count = released(material);
    let mapFreed = false;
    map.addEventListener('dispose', () => (mapFreed = true));
    const phase = instances.array.slice();

    const rebuild = new MaterialRebuild();
    rebuild.request();
    rebuild.flush(scene, 0);

    expect(count.value).toBe(1);
    expect(mesh.material).toBe(material);
    expect(material.deformed).toBe(bend);
    expect(material.castShadowPositionNode).toBe(shadowBend);
    expect(shadowBend).not.toBeNull();
    expect(mapFreed).toBe(false);
    expect(instances.array).toEqual(phase);
  });

  it('holds a burst of failures to the budget, however many frames it spans', () => {
    const rebuild = new MaterialRebuild(2, 1000);
    const root = new Group();
    expect(rebuild.request()).toBe(true);
    rebuild.flush(root, 0);
    rebuild.flush(root, 500);
    expect(rebuild.request()).toBe(true);
    rebuild.flush(root, 900);
    rebuild.flush(root, 1800);
    expect(rebuild.request()).toBe(false);
    rebuild.flush(root, 2700);
    expect(rebuild.request()).toBe(false);
  });

  it('gives a burst after a quiet spell the whole budget again', () => {
    const rebuild = new MaterialRebuild(1, 1000);
    const root = new Group();
    rebuild.request();
    rebuild.flush(root, 0);
    expect(rebuild.request()).toBe(false);
    rebuild.flush(root, 100);
    rebuild.flush(root, 1099);
    expect(rebuild.request()).toBe(false);
    rebuild.flush(root, 1100);
    rebuild.flush(root, 2100);
    expect(rebuild.request()).toBe(true);
  });

  it('merges the requests made before a frame boundary into one rebuild', () => {
    const rebuild = new MaterialRebuild(2);
    expect(rebuild.request()).toBe(true);
    expect(rebuild.request()).toBe(true);
    rebuild.flush(new Group(), 0);
    expect(rebuild.request()).toBe(true);
    rebuild.flush(new Group(), 0);
    expect(rebuild.request()).toBe(false);
  });
});
