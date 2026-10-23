import type { RoomEntry } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import type { AssetIndex, OutputAsset } from './index-schema.ts';
import {
  ALL_ROOMS_MAX_BYTES,
  ROOM_MAX_BYTES,
  ambienceLoudnessProblems,
  roomProblems,
  roomStats,
} from './room-budgets.ts';

const sha = 'a'.repeat(64);

function prop(id: string, triangles: [number, number, number], bytes = 1000): OutputAsset {
  return {
    id,
    kind: 'room-furniture',
    lods: triangles.map((t, i) => ({
      file: `room-furniture/${id}/lod${i}.glb`,
      bytes: 1,
      sha256: sha,
      triangles: t,
      vertices: t,
    })),
    files: [{ file: `room-furniture/${id}/lod0.glb`, bytes, sha256: sha }],
  } as unknown as OutputAsset;
}

function hdri(id: string, bytes = 1000): OutputAsset {
  return {
    id,
    kind: 'hdri',
    lods: [],
    files: [{ file: `hdri/${id}/env.ktx2`, bytes, sha256: sha }],
  } as unknown as OutputAsset;
}

function audio(id: string, bytes = 1000): OutputAsset {
  return {
    id,
    kind: 'audio',
    lods: [],
    files: [{ file: `audio/${id}/${id}.m4a`, bytes, sha256: sha }],
  } as unknown as OutputAsset;
}

function room(overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    id: 'room-shop',
    name: 'Shop',
    assets: { shell: null, furniture: ['p1', 'p2'], hdri: 'h1' },
    ambience: { sound: 'audio/a1/a1.m4a', asset: 'a1' },
    hasWindow: false,
    ...overrides,
  } as RoomEntry;
}

function refs(assets: OutputAsset[], drawCalls = 2, manifest?: string[]) {
  const index = { version: 1, assets } as unknown as AssetIndex;
  return {
    index,
    manifestIds: new Set(manifest ?? ['p1', 'p2', 'h1', 'a1']),
    drawCallsOf: () => drawCalls,
  };
}

const good = () => [
  prop('p1', [3000, 2000, 1000]),
  prop('p2', [4000, 3000, 2000]),
  hdri('h1'),
  audio('a1'),
];

describe('roomStats', () => {
  it('sums the LOD triangles and draw calls of a tier and the unique bytes', () => {
    const stats = roomStats(room(), refs(good(), 3));
    expect(stats.bytes).toBe(4000);
    expect(stats.tiers.high).toEqual({ triangles: 7000, drawCalls: 6 });
    expect(stats.tiers.mobile).toEqual({ triangles: 3000, drawCalls: 6 });
  });

  it('counts a file shared by two props once', () => {
    const a = prop('p1', [1, 1, 1]);
    const b = prop('p2', [1, 1, 1]);
    b.files = a.files;
    expect(roomStats(room(), refs([a, b, hdri('h1'), audio('a1')])).bytes).toBe(3000);
  });
});

describe('roomStats with a shell', () => {
  const withShell = () => room({ assets: { shell: 's1', furniture: ['p1'], hdri: null } });
  const assets = (shell: OutputAsset) => [shell, prop('p1', [3000, 2000, 1000]), audio('a1')];

  it('counts the shell bytes, triangles and draw calls', () => {
    const stats = roomStats(withShell(), refs(assets(prop('s1', [500, 400, 300], 5000)), 2));
    expect(stats.bytes).toBe(1000 + 5000 + 1000 - 1000 + 1000);
    expect(stats.tiers.mobile).toEqual({ triangles: 1300, drawCalls: 4 });
    expect(stats.tiers.high).toEqual({ triangles: 3500, drawCalls: 4 });
  });

  it('flags a shell that pushes the room over its byte budget', () => {
    const shell = prop('s1', [1, 1, 1], ROOM_MAX_BYTES);
    const problems = roomProblems([withShell()], refs(assets(shell), 1, ['s1', 'p1', 'a1']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('room budget');
  });

  it('flags a shell missing from the built index', () => {
    const problems = roomProblems(
      [withShell()],
      refs([prop('p1', [1, 1, 1]), audio('a1')], 1, ['s1', 'p1', 'a1']),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('shell "s1" is not in the built index');
  });
});

describe('roomProblems', () => {
  it('passes a room inside every budget', () => {
    expect(roomProblems([room()], refs(good()))).toEqual([]);
  });

  it('flags refs missing from the manifest', () => {
    const problems = roomProblems([room()], refs(good(), 2, ['p1', 'h1', 'a1']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"p2" is not in assets/manifest.json');
  });

  it('flags furniture and hdri missing from the built index', () => {
    const problems = roomProblems([room()], refs([prop('p1', [1, 1, 1]), audio('a1')]));
    expect(problems.some((p) => p.includes('furniture "p2" is not in the built index'))).toBe(true);
    expect(problems.some((p) => p.includes('hdri "h1" is not in the built index'))).toBe(true);
  });

  it('flags an ambience.sound the built audio does not provide', () => {
    const wrong = room({ ambience: { sound: 'audio/a1/other.m4a', asset: 'a1' } });
    const problems = roomProblems([wrong], refs(good()));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ambience.sound audio/a1/other.m4a');
  });

  it('allows a silent room without hdri', () => {
    const quiet = room({
      assets: { shell: null, furniture: ['p1'], hdri: null },
      ambience: { sound: null, asset: null },
    });
    expect(roomProblems([quiet], refs([prop('p1', [1, 1, 1])]))).toEqual([]);
  });

  it('flags a room over the per-room byte budget, counting its audio', () => {
    const heavy = [
      prop('p1', [1, 1, 1], ROOM_MAX_BYTES - 3000),
      prop('p2', [1, 1, 1]),
      hdri('h1'),
      audio('a1'),
    ];
    expect(roomProblems([room()], refs(heavy))).toEqual([]);
    heavy[3] = audio('a1', 5000);
    const problems = roomProblems([room()], refs(heavy));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('room budget');
  });

  it('flags the mobile tier on triangles and on draw calls', () => {
    const over = [prop('p1', [1, 1, 16_000]), prop('p2', [1, 1, 1]), hdri('h1'), audio('a1')];
    const triangles = roomProblems([room()], refs(over));
    expect(triangles).toHaveLength(1);
    expect(triangles[0]).toContain('mobile tier (LOD2) draws 16001 triangles');
    const draws = roomProblems([room()], refs(good(), 6));
    expect(draws.some((p) => p.includes('mobile tier (LOD2) needs 12 draw calls'))).toBe(true);
  });

  it('flags the high tier on triangles', () => {
    const over = [prop('p1', [61_000, 1, 1]), prop('p2', [1, 1, 1]), hdri('h1'), audio('a1')];
    const problems = roomProblems([room()], refs(over));
    expect(problems.some((p) => p.includes('high tier (LOD0) draws 61001 triangles'))).toBe(true);
  });

  it('flags the union of all rooms over its budget, counting shared files once', () => {
    const each = ROOM_MAX_BYTES - 100;
    const count = Math.floor(ALL_ROOMS_MAX_BYTES / each);
    const ids = Array.from({ length: count + 1 }, (_, n) => `p${n}`);
    const assets = [...ids.map((id) => prop(id, [1, 1, 1], each)), hdri('h1', 1), audio('a1', 1)];
    const rooms = ids.map((id) => room({ assets: { shell: null, furniture: [id], hdri: 'h1' } }));
    const manifest = [...ids, 'h1', 'a1'];
    const over = roomProblems(rooms, refs(assets, 1, manifest));
    expect(over).toHaveLength(1);
    expect(over[0]).toContain('all rooms ship');
    expect(roomProblems(rooms.slice(0, count), refs(assets, 1, manifest))).toEqual([]);
    const shared = rooms.map(() =>
      room({ assets: { shell: null, furniture: ['p0'], hdri: 'h1' } }),
    );
    expect(roomProblems(shared, refs(assets, 1, manifest))).toEqual([]);
  });
});

describe('ambienceLoudnessProblems', () => {
  const loud = (id: string, lufs: number) =>
    ({ ...audio(id), audio: { loudnessLufs: lufs } }) as unknown as OutputAsset;
  const rooms = ['a1', 'a2', 'a3'].map((id, n) =>
    room({
      id: `room-${n}`,
      ambience: { sound: null, asset: id },
    } as unknown as Partial<RoomEntry>),
  );
  const index = (levels: number[]) =>
    ({ version: 1, assets: levels.map((l, n) => loud(`a${n + 1}`, l)) }) as unknown as AssetIndex;

  it('accepts loops within the spread', () => {
    expect(ambienceLoudnessProblems(rooms, index([-26, -26.1, -25.2]))).toEqual([]);
  });

  it('names the quiet outlier, as the cabin loop was at -34.1 LUFS', () => {
    const problems = ambienceLoudnessProblems(rooms, index([-26, -34.1, -26]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('a2 at -34.1 LUFS');
    expect(problems[0]).toContain('8.1 LU');
  });

  it('is part of roomProblems', () => {
    const assets = [loud('a1', -26), loud('a2', -34), loud('a3', -26)];
    const problems = roomProblems(rooms, {
      index: { version: 1, assets } as unknown as AssetIndex,
      manifestIds: new Set(['a1', 'a2', 'a3']),
      drawCallsOf: () => 1,
    });
    expect(problems.some((p) => p.includes('ambience loudness'))).toBe(true);
  });
});
