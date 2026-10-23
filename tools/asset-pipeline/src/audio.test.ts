import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIO_RECIPES,
  decodeAudio,
  encodeM4a,
  LIMITER_CEILING_DB,
  modificationNotes,
  processAudio,
  rawAudioPath,
} from './audio.ts';
import {
  AUDIO_SAMPLE_RATE,
  integratedLoudness,
  limitPeaks,
  peakOf,
  linearToDb,
} from './audio-dsp.ts';
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

function peaky(seconds: number): Float32Array {
  const samples = tone(seconds, 300, 0.02);
  for (let i = 0; i < samples.length; i += AUDIO_SAMPLE_RATE) samples[i] = 0.9;
  return samples;
}

describe('limitPeaks', () => {
  it('holds every sample under the ceiling and leaves quiet audio alone', () => {
    const limited = limitPeaks(peaky(3), -6, 240);
    expect(peakOf(limited)).toBeLessThanOrEqual(10 ** (-6 / 20) + 1e-6);
    const quiet = tone(1, 440, 0.1);
    expect(limitPeaks(quiet, -6, 240)).toEqual(quiet);
  });

  it('limits a peak in the first samples', () => {
    const samples = new Float32Array(2000).fill(0.01);
    samples[3] = 1;
    expect(peakOf(limitPeaks(samples, -6, 240))).toBeLessThanOrEqual(10 ** (-6 / 20) + 1e-6);
  });
});

describe('limitPeaks at a loop seam', () => {
  const lookahead = 240;
  const gainAt = (input: Float32Array, output: Float32Array, i: number) =>
    (output[i] ?? NaN) / (input[i] ?? NaN);

  it('gives both ends of a loop the same gain when a transient sits near the end', () => {
    const samples = new Float32Array(48000).fill(0.2);
    samples[samples.length - 100] = 1;
    const looped = limitPeaks(samples, -6, lookahead, true);
    const plain = limitPeaks(samples, -6, lookahead);
    const last = samples.length - 1;
    const wrappedStep = Math.abs(gainAt(samples, looped, 0) - gainAt(samples, looped, last));
    const plainStep = Math.abs(gainAt(samples, plain, 0) - gainAt(samples, plain, last));
    expect(plainStep).toBeGreaterThan(0.2);
    expect(wrappedStep).toBeLessThan(0.005);
    expect(peakOf(looped)).toBeLessThanOrEqual(10 ** (-6 / 20) + 1e-6);
  });

  it('ducks the start of the loop for a transient within the look-ahead of the end', () => {
    const samples = new Float32Array(48000).fill(0.2);
    samples[samples.length - 10] = 1;
    const looped = limitPeaks(samples, -6, lookahead, true);
    expect(gainAt(samples, looped, 0)).toBeLessThan(1);
  });

  it('matches the unwrapped limiter when nothing is near the seam', () => {
    const samples = tone(1, 300, 0.02);
    samples[20000] = 0.9;
    expect(limitPeaks(samples, -6, lookahead, true)).toEqual(limitPeaks(samples, -6, lookahead));
  });
});

describe('processAudio with a limiter', () => {
  const loop = { crossfadeS: 0.25 };
  const base = { id: 'l', source: 's', role: 'l', targetLufs: -26, loop };

  it('cannot reach the target by plain gain when one peak caps it', () => {
    const plain = processAudio(peaky(4), base);
    expect(plain.peakLimited).toBe(true);
    expect(plain.loudnessLufs).toBeLessThan(-30);
  });

  it('reaches the target under the peak ceiling', () => {
    const limited = processAudio(peaky(4), { ...base, limit: true });
    expect(limited.loudnessLufs).toBeGreaterThan(-26.5);
    expect(limited.loudnessLufs).toBeLessThan(-25.5);
    expect(linearToDb(peakOf(limited.samples))).toBeLessThan(-1);
  });

  it('reports peakLimited only when the limiter leaves the clip short of the target', () => {
    const reached = processAudio(peaky(4), { ...base, limit: true });
    expect(reached.peakLimited).toBe(false);
    expect(modificationNotes({ ...base, limit: true }, reached).join('; ')).toContain(
      'normalised to -26 LUFS',
    );

    const unreachable = { ...base, targetLufs: 0, limit: true };
    const missed = processAudio(peaky(4), unreachable);
    expect(missed.peakLimited).toBe(true);
    const notes = modificationNotes(unreachable, missed).join('; ');
    expect(notes).not.toContain('normalised to');
    expect(notes).toContain('instead of the 0 LUFS target');
    expect(notes).toContain(`limited by the ${LIMITER_CEILING_DB} dBFS peak ceiling`);
    expect(notes).toContain('-2.5 dBFS peak ceiling');
  });
});

describe('processAudio', () => {
  it('cuts a loop to its length minus the crossfade and hits the target loudness', () => {
    const recipe = { id: 'l', source: 's', role: 'l', targetLufs: -23, loop: { crossfadeS: 0.5 } };
    const processed = processAudio(tone(4), recipe);
    expect(processed.samples.length).toBe(Math.round(3.5 * AUDIO_SAMPLE_RATE));
    expect(processed.loudnessLufs).toBeCloseTo(-23, 1);
  });

  it('takes the loop from inside the search range', () => {
    const quiet = tone(8, 440, 0.01);
    const loud = tone(8, 440, 0.4);
    const source = new Float32Array(quiet.length + loud.length);
    source.set(quiet);
    source.set(loud, quiet.length);
    const recipe = {
      id: 'l',
      source: 's',
      role: 'l',
      targetLufs: -30,
      loop: { crossfadeS: 0.5, loopS: 4, searchS: [8, 16] as [number, number] },
    };
    const inRange = processAudio(source, recipe);
    expect(inRange.samples.length).toBe(Math.round(4 * AUDIO_SAMPLE_RATE));
    expect(inRange.gainDb).toBeLessThan(0);
  });

  it('refuses a search range shorter than the loop', () => {
    const recipe = {
      id: 'l',
      source: 's',
      role: 'l',
      targetLufs: -23,
      loop: { crossfadeS: 0.2, loopS: 5, searchS: [0, 3] as [number, number] },
    };
    expect(() => processAudio(tone(10), recipe)).toThrow();
  });

  it('trims a one-shot and fades its end', () => {
    const lead = new Float32Array(AUDIO_SAMPLE_RATE / 2);
    const click = tone(0.2);
    const source = new Float32Array(lead.length * 2 + click.length);
    source.set(click, lead.length);
    const recipe = { id: 'o', source: 's', role: 'o', targetLufs: -20, fadeOutS: 0.05 };
    const processed = processAudio(source, recipe);
    expect(processed.samples.length / AUDIO_SAMPLE_RATE).toBeCloseTo(0.21, 2);
    expect(Math.abs(processed.samples.at(-1) ?? 1)).toBeLessThan(0.01);
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
              frames: AUDIO_SAMPLE_RATE,
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

  it('fails an MP4 file whose codec is not AAC', () => {
    const bytes = new Uint8Array(encodeM4a(tone(0.2)));
    const at = Buffer.from(bytes).indexOf('mp4a');
    bytes.set(new TextEncoder().encode('alac'), at);
    expect(problemsFor(audioAsset(bytes))).toContain('mp4a sample entry');
  });

  it('fails a frame count that disagrees with the duration', () => {
    const asset = audioAsset(encodeM4a(tone(1)));
    if (!asset.audio) throw new Error('fixture has no audio block');
    const audio = { ...asset.audio, frames: AUDIO_SAMPLE_RATE + 480 };
    expect(problemsFor({ ...asset, audio })).toContain('does not match frames');
  });

  it('fails an .m4a file on a non-audio asset', () => {
    const asset = audioAsset(encodeM4a(tone(0.2)), {
      id: 'tetra',
      file: 'fish/tetra/tetra.m4a',
    });
    expect(problemsFor({ ...asset, kind: 'fish' })).toContain('only the audio kind may ship');
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
      totalBytes: asset.files.reduce((sum, f) => sum + f.bytes, 0),
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
