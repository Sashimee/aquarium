import { BoxGeometry, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, Scene } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { createInertRenderer } from './inertRenderer';
import { compileInParallel } from './parallelCompile';

interface Link {
  resolve(): void;
  reject(cause: unknown): void;
}

/** A pipeline cache whose backend links in parallel whenever it is handed a promise list. */
function fakeCache() {
  const links: Link[] = [];
  const calls: { renderObject: object; parallel: boolean }[] = [];
  const pipelines = {
    getForRender(renderObject: object, promises: Promise<void>[] | null = null): unknown {
      calls.push({ renderObject, parallel: promises !== null });
      if (promises !== null) {
        promises.push(
          new Promise<void>((resolve, reject) => {
            links.push({ resolve, reject });
          }),
        );
      }
      return {};
    },
    updateForRender(renderObject: object): void {
      this.getForRender(renderObject);
    },
  };
  return { renderer: { _pipelines: pipelines }, pipelines, links, calls };
}

const flushTasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('compileInParallel', () => {
  it('starts accepted pipelines in parallel only inside during()', async () => {
    const { renderer, pipelines, links, calls } = fakeCache();
    const fish = { object: {} };
    const plant = { object: {} };
    const quad = { object: {} };
    const parallel = compileInParallel(renderer, (ro) => ro !== quad);

    pipelines.updateForRender(plant);
    parallel.during(() => {
      pipelines.updateForRender(fish);
      pipelines.updateForRender(quad);
    });
    pipelines.updateForRender({ object: {} });

    expect(calls.map((c) => c.parallel)).toEqual([false, true, false, false]);
    expect(calls[2]?.renderObject).toBe(quad);
    expect(parallel.started).toBe(1);
    expect(parallel.pending).toBe(1);
    links[0]?.resolve();
    await flushTasks();
    expect(parallel.pending).toBe(0);
    expect(parallel.started).toBe(1);
  });

  it('counts a link that rejects as settled', async () => {
    const { renderer, pipelines, links } = fakeCache();
    const parallel = compileInParallel(renderer, () => true);
    parallel.during(() => {
      pipelines.updateForRender({});
      pipelines.updateForRender({});
    });
    expect(parallel.pending).toBe(2);
    links[0]?.reject(new Error('lost context'));
    links[1]?.resolve();
    await flushTasks();
    expect(parallel.pending).toBe(0);
  });

  it('leaves the render path synchronous again after a draw that threw', () => {
    const { renderer, pipelines, calls } = fakeCache();
    const parallel = compileInParallel(renderer, () => true);
    expect(() =>
      parallel.during(() => {
        throw new Error('draw failed');
      }),
    ).toThrow('draw failed');
    pipelines.updateForRender({});
    expect(calls.map((c) => c.parallel)).toEqual([false]);
  });

  it('stays parallel through a nested during()', () => {
    const { renderer, pipelines, calls } = fakeCache();
    const parallel = compileInParallel(renderer, () => true);
    parallel.during(() => {
      parallel.during(() => pipelines.updateForRender({}));
      pipelines.updateForRender({});
    });
    expect(calls.map((c) => c.parallel)).toEqual([true, true]);
  });

  it('starts every pass of an object new this frame in parallel, and a rebuild after it in sync', () => {
    const { renderer, pipelines, calls } = fakeCache();
    const parallel = compileInParallel(renderer, () => true);
    const fish = {};
    parallel.during(() => {
      pipelines.updateForRender({ object: fish, pass: 'main' });
      pipelines.updateForRender({ object: fish, pass: 'shadow' });
    });
    parallel.during(() => pipelines.updateForRender({ object: fish, pass: 'tier change' }));
    expect(calls.map((c) => c.parallel)).toEqual([true, true, false]);
  });

  it('keeps a rebuild synchronous for an object a capture drew first', () => {
    const { renderer, pipelines, calls } = fakeCache();
    const parallel = compileInParallel(renderer, () => true);
    const fish = {};
    pipelines.updateForRender({ object: fish });
    parallel.during(() => pipelines.updateForRender({ object: fish }));
    expect(calls.map((c) => c.parallel)).toEqual([false, false]);
  });

  it('settles once every link in flight has, at once when none is', async () => {
    const { renderer, pipelines, links } = fakeCache();
    const parallel = compileInParallel(renderer, () => true);
    let settled = false;
    await parallel.settled();

    parallel.during(() => {
      pipelines.updateForRender({});
      pipelines.updateForRender({});
    });
    void parallel.settled().then(() => {
      settled = true;
    });
    links[0]?.resolve();
    await flushTasks();
    expect(settled).toBe(false);
    links[1]?.reject(new Error('lost context'));
    await flushTasks();
    expect(settled).toBe(true);
  });

  it('puts the cache back on restore, and not over a later patch', () => {
    const { renderer, pipelines, calls } = fakeCache();
    const own = pipelines.updateForRender;
    const parallel = compileInParallel(renderer, () => true);
    parallel.restore();
    expect(pipelines.updateForRender).toBe(own);
    parallel.during(() => pipelines.updateForRender({}));
    expect(calls.map((c) => c.parallel)).toEqual([false]);

    const again = compileInParallel(renderer, () => true);
    const later = vi.fn();
    pipelines.updateForRender = later;
    again.restore();
    expect(pipelines.updateForRender).toBe(later);
  });

  it('refuses a renderer without three’s pipeline cache', () => {
    expect(() => compileInParallel({}, () => true)).toThrow(/_pipelines/);
    expect(() => compileInParallel({ _pipelines: { getForRender() {} } }, () => true)).toThrow(
      /three changed its pipeline cache/,
    );
  });

  it('hands three’s render path a promise list for the scene, not for its output pass', async () => {
    const { renderer } = await createInertRenderer();
    const pipelines: unknown = Reflect.get(renderer, '_pipelines');
    if (typeof pipelines !== 'object' || pipelines === null) throw new Error('no _pipelines');
    const getForRender = vi.spyOn(pipelines as { getForRender: () => unknown }, 'getForRender');
    const scene = new Scene();
    const box = new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial());
    scene.add(box);
    const camera = new PerspectiveCamera();
    camera.position.z = 5;
    const parallel = compileInParallel(renderer, (ro) => Reflect.get(ro, 'scene') === scene);
    const drawn = () =>
      getForRender.mock.calls.map((args: unknown[]) => ({
        box: Reflect.get(args[0] as object, 'object') === box,
        parallel: Array.isArray(args[1]),
      }));

    parallel.during(() => renderer.render(scene, camera));
    expect(drawn()).toContainEqual({ box: true, parallel: true });
    expect(drawn().filter((d) => d.parallel)).toEqual([{ box: true, parallel: true }]);
    expect(drawn().some((d) => !d.box && !d.parallel)).toBe(true);

    getForRender.mockClear();
    renderer.render(scene, camera);
    expect(drawn().some((d) => d.parallel)).toBe(false);
    parallel.restore();
  });

  it('lets a capture that waits for settled() draw an object whose link was in flight', async () => {
    const { renderer, scene, box, camera, draws, links } = await linkingRenderer();
    const parallel = compileInParallel(renderer, (ro) => Reflect.get(ro, 'scene') === scene);

    parallel.during(() => renderer.render(scene, camera));
    expect(draws()).toEqual([]);
    renderer.render(scene, camera);
    expect(draws(), 'a capture before the link finishes misses the box').toEqual([]);

    const ready = parallel.settled();
    for (const link of links.splice(0)) link();
    await ready;
    renderer.render(scene, camera);
    expect(draws()).toEqual([box]);
    parallel.restore();
  });

  it('rebuilds the pipeline of an object already on screen synchronously and keeps drawing it', async () => {
    const { renderer, scene, box, camera, draws, links } = await linkingRenderer();
    const parallel = compileInParallel(renderer, (ro) => Reflect.get(ro, 'scene') === scene);
    parallel.during(() => renderer.render(scene, camera));
    for (const link of links.splice(0)) link();
    await parallel.settled();
    parallel.during(() => renderer.render(scene, camera));
    expect(draws()).toEqual([box]);

    box.material.transparent = true;
    box.material.needsUpdate = true;
    parallel.during(() => renderer.render(scene, camera));
    expect(draws(), 'the tier change frame still draws the box').toEqual([box]);
    expect(links).toEqual([]);
    expect(parallel.started).toBe(1);
    parallel.restore();
  });
});

/**
 * three's renderer on the inert backend, made to link like WebGL with KHR_parallel_shader_compile:
 * a pipeline started with a promise list is ready only once the test runs its link.
 */
async function linkingRenderer() {
  const { renderer } = await createInertRenderer();
  const backend = renderer.backend;
  const backendData: unknown = Reflect.get(backend, 'data');
  if (!(backendData instanceof WeakMap)) throw new Error('three changed its backend data map');
  const links: (() => void)[] = [];
  const drawn: object[] = [];
  Reflect.set(
    backend,
    'createRenderPipeline',
    (renderObject: object, promises: Promise<void>[] | null) => {
      const pipeline: unknown = Reflect.get(renderObject, 'pipeline');
      if (typeof pipeline !== 'object' || pipeline === null) throw new Error('no pipeline to link');
      const link = (): void => {
        backendData.set(pipeline, { pipeline: {} });
      };
      if (promises === null) link();
      else promises.push(new Promise<void>((resolve) => links.push(() => (link(), resolve()))));
    },
  );
  Reflect.set(backend, 'draw', (renderObject: object) => {
    drawn.push(Reflect.get(renderObject, 'object') as object);
  });
  const scene = new Scene();
  const box = new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial());
  scene.add(box);
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const draws = (): object[] => drawn.splice(0).filter((object) => object === box);
  return { renderer, scene, box, camera, draws, links };
}
