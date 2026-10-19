import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_IDS, DEFAULT_BACKGROUND_ID } from '@aquarium/shared';
import { Texture } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import assetIndex from '../../../public/assets/index.json';
import { TIERS, type Tier } from '../quality/tiers';
import {
  backgroundFile,
  parseBackgroundFiles,
  pickBackgroundId,
  TankBackground,
  type BackgroundLoader,
} from './background';

const ROOT = '/assets/';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeLoader implements BackgroundLoader {
  readonly requests: { url: string; done: ReturnType<typeof deferred<Texture>> }[] = [];

  loadAsync(url: string): Promise<Texture> {
    const done = deferred<Texture>();
    this.requests.push({ url, done });
    return done.promise;
  }

  /** Answers the oldest unanswered request for `file` with a fresh texture. */
  land(file: string): Texture {
    const request = this.take(file);
    const texture = new Texture();
    texture.name = file;
    request.done.resolve(texture);
    return texture;
  }

  fail(file: string): void {
    this.take(file).done.reject(new Error('HTTP 404'));
  }

  private take(file: string): FakeLoader['requests'][number] {
    const at = this.requests.findIndex((r) => r.url === `${ROOT}${file}`);
    const request = at < 0 ? undefined : this.requests.splice(at, 1)[0];
    if (request === undefined) throw new Error(`no request for ${file}`);
    return request;
  }

  urls(): string[] {
    return this.requests.map((r) => r.url);
  }
}

function disposed(texture: Texture): () => boolean {
  let gone = false;
  texture.addEventListener('dispose', () => {
    gone = true;
  });
  return () => gone;
}

function file(id: string, tier: Tier): string {
  return `background/${id}/${tier}.ktx2`;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Shows `id` and lands its picture, so the index is in for what follows. */
async function showing(
  background: TankBackground,
  loader: FakeLoader,
  id: string,
  tier: Tier = 'high',
): Promise<Texture> {
  const shown = background.show(id.startsWith('bg-reef') ? 'reef' : 'freshwater', id);
  await settle();
  const picture = loader.land(file(id, tier));
  await shown;
  return picture;
}

function setup(tier: Tier = 'high', fetchIndex: () => Promise<unknown> = async () => assetIndex) {
  const loader = new FakeLoader();
  const background = new TankBackground(loader, tier, { assetRoot: ROOT, fetchIndex });
  const film = background.map.value;
  return { loader, background, film };
}

const STREAM = 'bg-fw-planted-stream';
const ROOTS = 'bg-fw-root-tangle';
const CORAL = 'bg-reef-coral-wall';

describe('pickBackgroundId', () => {
  it("keeps the tank's own background when it belongs to the biome", () => {
    expect(pickBackgroundId('freshwater', ROOTS)).toBe(ROOTS);
    expect(pickBackgroundId('reef', 'bg-reef-deep-blue')).toBe('bg-reef-deep-blue');
  });

  it("falls back to the biome's default for null, an unknown id or another biome's id", () => {
    expect(pickBackgroundId('freshwater', null)).toBe(DEFAULT_BACKGROUND_ID.freshwater);
    expect(pickBackgroundId('reef', 'bg-reef-gone')).toBe(DEFAULT_BACKGROUND_ID.reef);
    expect(pickBackgroundId('reef', '')).toBe(DEFAULT_BACKGROUND_ID.reef);
    expect(pickBackgroundId('freshwater', CORAL)).toBe(DEFAULT_BACKGROUND_ID.freshwater);
  });

  it('gives no picture to a biome that has none yet', () => {
    expect(pickBackgroundId('cichlid', null)).toBeNull();
    expect(pickBackgroundId('mangrove', STREAM)).toBeNull();
  });
});

describe('parseBackgroundFiles', () => {
  const files = parseBackgroundFiles(assetIndex);

  it('finds a file for every background and tier in the shipped index, on disk', () => {
    // The pipeline ships the high picture again as ultra; the identical copy is never fetched.
    for (const id of [...BACKGROUND_IDS.freshwater, ...BACKGROUND_IDS.reef]) {
      for (const tier of TIERS) {
        const path = backgroundFile(files, id, tier);
        expect(path).toBe(file(id, tier === 'ultra' ? 'high' : tier));
        expect(existsSync(join(__dirname, '../../../public/assets', path)), path).toBe(true);
      }
    }
  });

  it('shares one path between tiers whose files are identical', () => {
    const tiers = Object.fromEntries(
      TIERS.map((t) => [t, { file: file(STREAM, t), sha256: t === 'low' ? 'a' : 'b' }]),
    );
    const parsed = parseBackgroundFiles({
      assets: [{ id: STREAM, kind: 'background', background: { tiers } }],
    }).get(STREAM);
    expect(parsed).toEqual({
      low: file(STREAM, 'low'),
      medium: file(STREAM, 'medium'),
      high: file(STREAM, 'medium'),
      ultra: file(STREAM, 'medium'),
    });
  });

  it('ignores other kinds and ids the shared contract does not know', () => {
    const parsed = parseBackgroundFiles({
      assets: [
        { id: 'studio', kind: 'hdri' },
        { id: 'bg-fw-new', kind: 'background', background: { tiers: {} } },
      ],
    });
    expect(parsed.size).toBe(0);
  });

  it('rejects a tier that is missing or a path that leaves the assets folder', () => {
    const tiers = Object.fromEntries(TIERS.map((t) => [t, { file: file(STREAM, t) }]));
    const entry = (t: object) => ({
      assets: [{ id: STREAM, kind: 'background', background: { tiers: t } }],
    });
    expect(parseBackgroundFiles(entry(tiers)).get(STREAM)?.low).toBe(file(STREAM, 'low'));
    expect(() => parseBackgroundFiles(entry({ ...tiers, low: undefined }))).toThrow(
      /tiers\.low must be an object/,
    );
    for (const bad of ['../x.ktx2', '/abs.ktx2', 'background/x.png']) {
      expect(() => parseBackgroundFiles(entry({ ...tiers, ultra: { file: bad } }))).toThrow(
        /relative \.ktx2 path/,
      );
    }
    expect(() => parseBackgroundFiles({})).toThrow(/assets must be an array/);
  });

  it('names the asset pipeline when a background is missing from the index', () => {
    expect(() => backgroundFile(new Map(), STREAM, 'low')).toThrow(/re-run the asset pipeline/);
  });
});

describe('TankBackground', () => {
  it("loads the tier's picture of the biome's default and shows it once it lands", async () => {
    const { loader, background, film } = setup('low');
    expect(film.name).toBe('backdrop-film');
    const shown = background.show('freshwater', null);
    await settle();
    expect(loader.urls()).toEqual([`${ROOT}${file(STREAM, 'low')}`]);
    expect(background.map.value).toBe(film);
    const picture = loader.land(file(STREAM, 'low'));
    await shown;
    expect(background.id).toBe(STREAM);
    expect(background.file).toBe(file(STREAM, 'low'));
    expect(background.map.value).toBe(picture);
  });

  it('frees the old picture when the background changes', async () => {
    const { loader, background } = setup();
    const first = background.show('freshwater', STREAM);
    await settle();
    const stream = loader.land(file(STREAM, 'high'));
    await first;
    const streamGone = disposed(stream);

    const second = background.show('reef', CORAL);
    await settle();
    expect(background.map.value).toBe(stream);
    const coral = loader.land(file(CORAL, 'high'));
    await second;
    expect(background.map.value).toBe(coral);
    expect(streamGone()).toBe(true);
  });

  it('swaps to the new size on a tier change, and skips a tier that shares the file', async () => {
    const { loader, background } = setup('high');
    const high = await showing(background, loader, CORAL);
    const highGone = disposed(high);

    await background.setTier('ultra');
    expect(loader.urls()).toEqual([]);
    expect(background.file).toBe(file(CORAL, 'high'));

    const lowered = background.setTier('medium');
    await settle();
    const medium = loader.land(file(CORAL, 'medium'));
    await lowered;
    expect(background.map.value).toBe(medium);
    expect(highGone()).toBe(true);
  });

  it('only fetches what is still wanted once requests made together are resolved', async () => {
    const { loader, background } = setup();
    await showing(background, loader, CORAL);
    const requests = [STREAM, ROOTS, STREAM].map((id) => background.show('freshwater', id));
    await settle();
    expect(loader.urls()).toEqual([`${ROOT}${file(STREAM, 'high')}`]);
    const stream = loader.land(file(STREAM, 'high'));
    await Promise.all(requests);
    expect(background.map.value).toBe(stream);
  });

  it('frees a load overtaken by a later request, and shows only the latest', async () => {
    const { loader, background } = setup();
    await showing(background, loader, CORAL);
    const first = background.show('freshwater', STREAM);
    await settle();
    const second = background.show('freshwater', ROOTS);
    await settle();
    const roots = loader.land(file(ROOTS, 'high'));
    await second;
    const stream = loader.land(file(STREAM, 'high'));
    const streamGone = disposed(stream);
    await first;
    expect(streamGone()).toBe(true);
    expect(background.map.value).toBe(roots);
  });

  it('downloads a file once while it is in flight, however often it is asked for', async () => {
    const { loader, background } = setup();
    await showing(background, loader, CORAL);
    const a = background.show('freshwater', STREAM);
    await settle();
    const b = background.show('freshwater', ROOTS);
    await settle();
    const c = background.show('freshwater', STREAM);
    await settle();
    expect(loader.urls().sort()).toEqual(
      [`${ROOT}${file(ROOTS, 'high')}`, `${ROOT}${file(STREAM, 'high')}`].sort(),
    );
    const stream = loader.land(file(STREAM, 'high'));
    loader.land(file(ROOTS, 'high'));
    await Promise.all([a, b, c]);
    expect(background.map.value).toBe(stream);
  });

  it('shows the plain film for a biome without pictures and frees the old one', async () => {
    const { loader, background, film } = setup();
    const shown = background.show('reef', null);
    await settle();
    const coral = loader.land(file(CORAL, 'high'));
    await shown;
    const coralGone = disposed(coral);
    await background.show('cichlid', null);
    expect(background.id).toBeNull();
    expect(background.map.value).toBe(film);
    expect(coralGone()).toBe(true);
  });

  it('falls back to the film when the wanted picture fails, rather than keep the wrong one', async () => {
    const { loader, background, film } = setup();
    const first = background.show('reef', null);
    await settle();
    const coral = loader.land(file(CORAL, 'high'));
    await first;
    const coralGone = disposed(coral);

    const second = background.show('freshwater', null);
    await settle();
    loader.fail(file(STREAM, 'high'));
    await expect(second).rejects.toThrow(`/assets/${file(STREAM, 'high')}`);
    expect(background.map.value).toBe(film);
    expect(coralGone()).toBe(true);
  });

  it('retries the index after it failed to load', async () => {
    let calls = 0;
    const { loader, background } = setup('low', async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return assetIndex;
    });
    await expect(background.show('freshwater', null)).rejects.toThrow('offline');
    const retry = background.show('freshwater', null);
    await settle();
    loader.land(file(STREAM, 'low'));
    await retry;
    expect(calls).toBe(2);
    expect(background.file).toBe(file(STREAM, 'low'));
  });

  it('frees the picture and the film on dispose, and a load that lands afterwards', async () => {
    const { loader, background, film } = setup();
    const first = background.show('freshwater', null);
    await settle();
    const stream = loader.land(file(STREAM, 'high'));
    await first;
    const second = background.show('reef', null);
    await settle();
    const streamGone = disposed(stream);
    const filmGone = disposed(film);

    background.dispose();
    expect(streamGone()).toBe(true);
    expect(filmGone()).toBe(true);
    const late = loader.land(file(CORAL, 'high'));
    const lateGone = disposed(late);
    await second;
    expect(lateGone()).toBe(true);
    expect(() => background.show('reef', null)).toThrow(/after dispose/);
    background.dispose();
  });
});
