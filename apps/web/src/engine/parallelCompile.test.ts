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

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('compileInParallel', () => {
  it('starts accepted pipelines in parallel only inside during()', async () => {
    const { renderer, pipelines, links, calls } = fakeCache();
    const scene = {};
    const quad = {};
    const parallel = compileInParallel(renderer, (ro) => ro === scene);

    pipelines.updateForRender(scene);
    parallel.during(() => {
      pipelines.updateForRender(scene);
      pipelines.updateForRender(quad);
    });
    pipelines.updateForRender(scene);

    expect(calls.map((c) => c.parallel)).toEqual([false, true, false, false]);
    expect(calls[2]?.renderObject).toBe(quad);
    expect(parallel.started).toBe(1);
    expect(parallel.pending).toBe(1);
    links[0]?.resolve();
    await settled();
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
    await settled();
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
});
