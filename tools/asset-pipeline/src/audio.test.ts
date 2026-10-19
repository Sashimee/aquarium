import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIO_RECIPES, decodeAudio, encodeM4a, processAudio, rawAudioPath } from './audio.ts';
import { AUDIO_SAMPLE_RATE, integratedLoudness } from './audio-dsp.ts';
import { checkAssets, type CheckInput } from './check.ts';
import { sha256 } from './glb.ts';
import type { AssetIndex, OutputAsset } from './index-schema.ts';
import type { Manifest } from './manifest.ts';

function tone(seconds: number, hz = 440, amplitude = 0.3): Float32Array {
  return Float32Array.from(
    { length: Math.round(seconds * AUDIO_SAMPLE_RATE) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / AUDIO_SAMPLE_RATE),
  );
}

describe('AUDIO_RECIPES', () => {
  it('has unique ids and one recipe per sourced sound', () => {
    expect(new Set(AUDIO_RECIPES.map((r) => r.id)).size).toBe(AUDIO_RECIPES.length);
    expect(new Set(AUDIO_RECIPES.map((r) => r.source)).size).toBe(9);
  });
});

describe('encodeM4a', () => {
  it('writes an MP4 container that decodes back to about the same length', () => {
    const m4a = encodeM4a(tone(1));
    expect(String.fromCharCode(...m4a.subarray(4, 8))).toBe('ftyp');
    const dir = mkdtempSync(join(tmpdir(), 'aquarium-audio-test-'));
    try {
      const path = join(dir, 'tone.m4a');
      writeFileSync(path, m4a);
      const decoded = decodeAudio(path, []);
      expect(Math.abs(decoded.length - AUDIO_SAMPLE_RATE)).toBeLessThan(2100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is byte-identical across runs', () => {
    const samples = tone(0.5, 880);
    expect(sha256(encodeM4a(samples))).toBe(sha256(encodeM4a(samples)));
  });
});

describe('processAudio', () => {
  it('cuts a loop to its length minus the crossfade and hits the target loudness', () => {
    const recipe = { id: 'l', source: 's', role: 'l', targetLufs: -23, loop: { crossfadeS: 0.5 } };
    const processed = processAudio(tone(4), recipe);
    expect(processed.samples.length).toBe(Math.round(3.5 * AUDIO_SAMPLE_RATE));
    expect(processed.loudnessLufs).toBeCloseTo(-23, 1);
  });

  it('trims a one-shot and fades its end', () => {
    const lead = new Float32Array(AUDIO_SAMPLE_RATE / 2);
    const click = tone(0.2);
    const source = new Float32Array(lead.length * 2 + click.length);
    source.set(click, lead.length);
    const recipe = { id: 'o', source: 's', role: 'o', targetLufs: -20, fadeOutS: 0.05 };
    const processed = processAudio(source, recipe);
    expect(processed.samples.length / AUDIO_SAMPLE_RATE).toBeCloseTo(0.21, 2);
    expect(Math.abs(processed.samples[processed.samples.length - 1]!)).toBeLessThan(0.01);
    expect(integratedLoudness(processed.samples)).toBeCloseTo(processed.loudnessLufs, 5);
  });

  it('refuses a silent one-shot', () => {
    const recipe = { id: 'o', source: 's', role: 'o', targetLufs: -20 };
    expect(() => processAudio(new Float32Array(AUDIO_SAMPLE_RATE), recipe)).toThrow();
  });

  it('refuses a silent loop', () => {
    const recipe = { id: 'l', source: 's', role: 'l', targetLufs: -23, loop: { crossfadeS: 0.1 } };
    expect(() => processAudio(new Float32Array(AUDIO_SAMPLE_RATE), recipe)).toThrow();
  });

  it('refuses a loop source shorter than its crossfade', () => {
    const recipe = { id: 'l', source: 's', role: 'l', targetLufs: -23, loop: { crossfadeS: 1 } };
    expect(() => processAudio(tone(0.5), recipe)).toThrow();
  });

  it('refuses a source shorter than the requested stationary loop window', () => {
    const recipe = {
      id: 'l',
      source: 's',
      role: 'l',
      targetLufs: -23,
      loop: { crossfadeS: 0.2, loopS: 5 },
    };
    expect(() => processAudio(tone(2), recipe)).toThrow();
  });
});

describe('rawAudioPath', () => {
  it('rejects a raw directory without exactly one ogg', () => {
    const root = mkdtempSync(join(tmpdir(), 'aquarium-raw-test-'));
    try {
      mkdirSync(join(root, 'freesound-1'));
      expect(() => rawAudioPath(root, 'freesound-1')).toThrow('found 0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('audio checks', () => {
  let root: string;
  let assetsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'audio-check-'));
    assetsDir = join(root, 'assets');
    mkdirSync(assetsDir, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const manifest: Manifest = {
    version: 1,
    status_values: ['downloaded'],
    rules: [],
    assets: [
      {
        id: 'freesound-1',
        kind: 'audio',
        title: 'T',
        author: 'A',
        author_url: 'https://example.com',
        source_url: 'https://example.com',
        licence: 'CC0-1.0',
        licence_url: 'https://example.com',
        sha256: 'a'.repeat(64),
        modifications: [],
        status: 'downloaded',
      },
    ],
  };

  function audioAsset(
    bytes: Uint8Array,
    options: { audio?: boolean; id?: string; file?: string } = {},
  ): OutputAsset {
    const id = options.id ?? 'hum';
    const file = options.file ?? `audio/${id}/${id}.m4a`;
    const path = join(assetsDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return {
      id,
      kind: 'audio',
      origin: 'recording',
      sources: ['freesound-1'],
      licence: 'CC0-1.0',
      modifications: [],
      lods: [],
      textures: [],
      files: [{ file, bytes: bytes.byteLength, sha256: sha256(bytes) }],
      ...(options.audio === false
        ? {}
        : {
            audio: {
              role: 'filter-hum',
              loop: true,
              durationS: 1,
              sampleRate: AUDIO_SAMPLE_RATE,
              channels: 1,
              bitrateKbps: 64,
              loudnessLufs: -23,
              file: `audio/${id}/${id}.m4a`,
            },
          }),
    };
  }

  function problemsFor(...assets: OutputAsset[]): string {
    const index: AssetIndex = {
      version: 1,
      textureVariants: '',
      customAttributes: '',
      totalBytes: assets.flatMap((a) => a.files).reduce((s, f) => s + f.bytes, 0),
      assets,
    };
    const input: CheckInput = { manifest, credits: '', index, assetsDir, repoRoot: root };
    return checkAssets(input).join('\n');
  }

  function padded(bytes: number): Uint8Array {
    const out = new Uint8Array(bytes);
    out.set(encodeM4a(tone(0.2)));
    return out;
  }

  it('passes a real encoded sound', () => {
    expect(problemsFor(audioAsset(encodeM4a(tone(1))))).toBe('');
  });

  it('fails a file that is not an MP4 container', () => {
    const wav = new TextEncoder().encode('RIFF....WAVEfmt ');
    expect(problemsFor(audioAsset(wav))).toContain('not an MP4/M4A container');
  });

  it('fails a sound without its audio block', () => {
    expect(problemsFor(audioAsset(encodeM4a(tone(0.2)), { audio: false }))).toContain(
      'has no audio block',
    );
  });

  it('fails a sound over the per-file budget', () => {
    expect(problemsFor(audioAsset(padded(1_000_001)))).toContain('per-sound budget');
  });

  it('fails the audio total over its budget', () => {
    const sounds = Array.from({ length: 6 }, (_, i) =>
      audioAsset(padded(900_000), { id: `hum-${i}` }),
    );
    expect(problemsFor(...sounds)).toContain('audio budget');
  });

  it('fails a sound whose source is not in the manifest', () => {
    const asset = audioAsset(encodeM4a(tone(0.2)));
    expect(problemsFor({ ...asset, sources: ['freesound-missing'] })).toContain(
      'freesound-missing',
    );
  });

  it('fails a sound whose source has a disallowed licence', () => {
    const asset = audioAsset(encodeM4a(tone(0.2)));
    const restricted: Manifest = {
      ...manifest,
      assets: manifest.assets.map((a) => ({ ...a, licence: 'CC-BY-NC-4.0' })),
    };
    const index: AssetIndex = {
      version: 1,
      textureVariants: '',
      customAttributes: '',
      totalBytes: asset.files[0]!.bytes,
      assets: [asset],
    };
    const problems = checkAssets({
      manifest: restricted,
      credits: '',
      index,
      assetsDir,
      repoRoot: root,
    });
    expect(problems.join('\n')).toContain('disallowed licence');
  });

  it('fails an audio file outside its asset directory', () => {
    const asset = audioAsset(encodeM4a(tone(0.2)), { file: 'audio/other/hum.m4a' });
    expect(problemsFor(asset)).toContain('outside the asset directory');
  });
});
