import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import {
  AUDIO_SAMPLE_RATE,
  fadeIn,
  fadeOut,
  integratedLoudness,
  limitedNormalise,
  loopCrossfade,
  normaliseLoudness,
  stationaryStart,
  trimSilence,
} from './audio-dsp.ts';
import { sha256 } from './glb.ts';
import type { FishContext } from './fish.ts';
import type { OutputAsset } from './index-schema.ts';

export const AUDIO_BITRATE_KBPS = 64;
export const PEAK_CEILING_DB = -1;
/** AAC reconstruction overshot the sample peak by up to 0.8 dB when measured, so limited clips stop 1.5 dB short of the plain ceiling. */
export const LIMITER_CEILING_DB = PEAK_CEILING_DB - 1.5;
const LIMITER_LOOKAHEAD_S = 0.005;
const SILENCE_THRESHOLD_DB = -50;
const SILENCE_MARGIN_S = 0.005;
const ONE_SHOT_FADE_IN_S = 0.002;

export interface AudioRecipe {
  id: string;
  source: string;
  role: string;
  targetLufs: number;
  highpassHz?: number;
  lowpassHz?: number;
  /** Loops are cut from a stationary window of `loopS` and joined with a `crossfadeS` crossfade. */
  loop?: { crossfadeS: number; loopS?: number; searchS?: [number, number] };
  fadeOutS?: number;
  /** Look-ahead peak limiting before the loudness target; for sources whose peaks cap the plain gain. */
  limit?: boolean;
}

export const AUDIO_RECIPES: readonly AudioRecipe[] = [
  {
    id: 'filter-hum',
    source: 'freesound-197804',
    role: 'filter-hum',
    targetLufs: -23,
    highpassHz: 60,
    loop: { loopS: 12, crossfadeS: 1 },
  },
  {
    id: 'air-bubbles',
    source: 'freesound-188223',
    role: 'air-bubbles',
    targetLufs: -26,
    highpassHz: 200,
    loop: { crossfadeS: 0.25 },
  },
  {
    id: 'underwater-bed',
    source: 'freesound-862788',
    role: 'underwater-ambience',
    targetLufs: -28,
    lowpassHz: 1500,
    loop: { loopS: 16, crossfadeS: 2 },
  },
  { id: 'glass-tap', source: 'freesound-427389', role: 'glass-tap', targetLufs: -18 },
  {
    id: 'food-plop',
    source: 'freesound-853279',
    role: 'food-plop',
    targetLufs: -22,
    lowpassHz: 6000,
  },
  {
    id: 'net-splash',
    source: 'freesound-398032',
    role: 'net-splash',
    targetLufs: -18,
    fadeOutS: 0.08,
  },
  { id: 'ui-click-1', source: 'freesound-528561', role: 'ui-click', targetLufs: -26 },
  { id: 'ui-click-2', source: 'freesound-629020', role: 'ui-click', targetLufs: -26 },
  { id: 'ui-click-3', source: 'freesound-342200', role: 'ui-click', targetLufs: -26 },
];

function ffmpeg(args: string[], input?: Uint8Array): Buffer {
  const result = spawnSync(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error', ...args], {
    ...(input ? { input } : {}),
    maxBuffer: 1 << 30,
  });
  if (result.error) throw new Error(`could not run ffmpeg: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

/** Decodes to 48 kHz mono float32, applying the recipe's filters. Only a hash-verified file reaches this. */
export function decodeAudio(path: string, filters: string[]): Float32Array {
  const stdout = ffmpeg([
    '-protocol_whitelist',
    'file',
    '-i',
    path,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    ...(filters.length > 0 ? ['-af', filters.join(',')] : []),
    '-f',
    'f32le',
    'pipe:1',
  ]);
  const bytes = new Uint8Array(stdout.byteLength - (stdout.byteLength % 4));
  bytes.set(stdout.subarray(0, bytes.length));
  return new Float32Array(bytes.buffer);
}

export function encodeM4a(samples: Float32Array, bitrateKbps = AUDIO_BITRATE_KBPS): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'aquarium-m4a-'));
  const out = join(dir, 'out.m4a');
  try {
    ffmpeg(
      [
        '-f',
        'f32le',
        '-ar',
        String(AUDIO_SAMPLE_RATE),
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-c:a',
        'aac',
        '-b:a',
        `${bitrateKbps}k`,
        '-fflags',
        '+bitexact',
        '-flags:a',
        '+bitexact',
        '-map_metadata',
        '-1',
        '-movflags',
        '+faststart',
        '-y',
        out,
      ],
      new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
    );
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ProcessedAudio {
  samples: Float32Array;
  loudnessLufs: number;
  gainDb: number;
  peakLimited: boolean;
}

export function processAudio(source: Float32Array, recipe: AudioRecipe): ProcessedAudio {
  const rate = AUDIO_SAMPLE_RATE;
  let samples: Float32Array;
  if (recipe.loop) {
    const fade = Math.round(recipe.loop.crossfadeS * rate);
    let segment = source;
    if (recipe.loop.loopS !== undefined) {
      const length = Math.round(recipe.loop.loopS * rate) + fade;
      const [from, to] = recipe.loop.searchS ?? [0, source.length / rate];
      const offset = Math.round(from * rate);
      const region = source.subarray(offset, Math.min(source.length, Math.round(to * rate)));
      const start = offset + stationaryStart(region, length);
      segment = source.slice(start, start + length);
    }
    samples = loopCrossfade(segment, fade);
  } else {
    samples = trimSilence(source, SILENCE_THRESHOLD_DB, Math.round(SILENCE_MARGIN_S * rate));
    samples = fadeIn(samples, Math.round(ONE_SHOT_FADE_IN_S * rate));
    if (recipe.fadeOutS) samples = fadeOut(samples, Math.round(recipe.fadeOutS * rate));
  }
  const normalised = recipe.limit
    ? limitedNormalise(
        samples,
        recipe.targetLufs,
        LIMITER_CEILING_DB,
        Math.round(LIMITER_LOOKAHEAD_S * rate),
        recipe.loop !== undefined,
      )
    : normaliseLoudness(samples, recipe.targetLufs, PEAK_CEILING_DB);
  return {
    samples: normalised.samples,
    gainDb: normalised.gainDb,
    peakLimited: normalised.peakLimited,
    loudnessLufs: integratedLoudness(normalised.samples),
  };
}

export function modificationNotes(recipe: AudioRecipe, processed: ProcessedAudio): string[] {
  const notes: string[] = ['downmixed to mono and resampled to 48 kHz'];
  if (recipe.highpassHz) notes.push(`high-pass at ${recipe.highpassHz} Hz`);
  if (recipe.lowpassHz) notes.push(`low-pass at ${recipe.lowpassHz} Hz`);
  if (recipe.loop) {
    const window = recipe.loop.loopS
      ? `trimmed to a ${recipe.loop.loopS} s stationary section${recipe.loop.searchS ? ` chosen between ${recipe.loop.searchS[0]} s and ${recipe.loop.searchS[1]} s of the recording` : ''}; `
      : '';
    notes.push(`${window}${recipe.loop.crossfadeS} s equal-power crossfade of the loop seam`);
  } else {
    notes.push(`trimmed leading and trailing silence, ${ONE_SHOT_FADE_IN_S * 1000} ms fade-in`);
    if (recipe.fadeOutS) notes.push(`${Math.round(recipe.fadeOutS * 1000)} ms fade-out`);
  }
  if (recipe.limit)
    notes.push(
      `${LIMITER_LOOKAHEAD_S * 1000} ms look-ahead peak limiter at ${LIMITER_CEILING_DB} dBFS`,
    );
  notes.push(
    processed.peakLimited
      ? `gain limited by the ${recipe.limit ? LIMITER_CEILING_DB : PEAK_CEILING_DB} dBFS peak ceiling, so the loudness is ${processed.loudnessLufs.toFixed(1)} LUFS instead of the ${recipe.targetLufs} LUFS target`
      : `normalised to ${recipe.targetLufs} LUFS`,
  );
  notes.push(`encoded as AAC-LC ${AUDIO_BITRATE_KBPS} kbit/s in .m4a`);
  return notes;
}

export function rawAudioPath(rawRoot: string, sourceId: string): string {
  const dir = join(rawRoot, sourceId);
  const files = readdirSync(dir).filter((name) => name.endsWith('.ogg'));
  const [file] = files;
  if (files.length !== 1 || file === undefined) {
    throw new Error(`${sourceId}: expected exactly one .ogg in ${dir}, found ${files.length}`);
  }
  return join(dir, file);
}

export function buildAudio(
  recipe: AudioRecipe,
  ctx: FishContext,
  rawRoot: string,
  licence: string,
): OutputAsset {
  ctx.verifySource(recipe.source);
  const filters = [
    ...(recipe.highpassHz ? [`highpass=f=${recipe.highpassHz}`] : []),
    ...(recipe.lowpassHz ? [`lowpass=f=${recipe.lowpassHz}`] : []),
  ];
  const decoded = decodeAudio(rawAudioPath(rawRoot, recipe.source), filters);
  const processed = processAudio(decoded, recipe);
  const bytes = encodeM4a(processed.samples);
  const file = `audio/${recipe.id}/${recipe.id}.m4a`;
  const outDir = join(ctx.outRoot, 'audio', recipe.id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(ctx.outRoot, file), bytes);
  return {
    id: recipe.id,
    kind: 'audio',
    origin: 'recording',
    sources: [recipe.source],
    licence,
    modifications: modificationNotes(recipe, processed),
    lods: [],
    textures: [],
    files: [{ file, bytes: bytes.length, sha256: sha256(bytes) }],
    audio: {
      role: recipe.role,
      loop: recipe.loop !== undefined,
      frames: processed.samples.length,
      durationS: Number((processed.samples.length / AUDIO_SAMPLE_RATE).toFixed(3)),
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 1,
      bitrateKbps: AUDIO_BITRATE_KBPS,
      loudnessLufs: Number(processed.loudnessLufs.toFixed(1)),
      file,
    },
  };
}
