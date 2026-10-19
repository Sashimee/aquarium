export interface SoundEntry {
  readonly id: string;
  readonly role: string;
  readonly url: string;
  readonly loop: boolean;
  readonly frames: number;
  readonly sampleRate: number;
}

export type SoundCatalog = ReadonlyMap<string, readonly SoundEntry[]>;

function fail(path: string, expected: string): never {
  throw new TypeError(`assets/index.json: ${path} must be ${expected}; re-run the asset pipeline`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Groups the `kind: audio` assets by `audio.role`; ids are not stable lookup keys. */
export function parseSoundCatalog(index: unknown, root: string): SoundCatalog {
  if (!isRecord(index) || !Array.isArray(index['assets'])) fail('assets', 'an array');
  const byRole = new Map<string, SoundEntry[]>();
  index['assets'].forEach((raw: unknown, i) => {
    if (!isRecord(raw) || raw['kind'] !== 'audio') return;
    const at = `assets[${i}]`;
    const audio = raw['audio'];
    if (!isRecord(audio)) fail(`${at}.audio`, 'an object');
    const { role, file, loop, frames, sampleRate } = audio;
    const id = raw['id'];
    if (typeof id !== 'string') fail(`${at}.id`, 'a string');
    if (typeof role !== 'string' || role === '') fail(`${at}.audio.role`, 'a non-empty string');
    if (typeof file !== 'string' || file === '') fail(`${at}.audio.file`, 'a non-empty string');
    if (typeof loop !== 'boolean') fail(`${at}.audio.loop`, 'a boolean');
    if (typeof frames !== 'number' || !(frames > 0))
      fail(`${at}.audio.frames`, 'a positive number');
    if (typeof sampleRate !== 'number' || !(sampleRate > 0)) {
      fail(`${at}.audio.sampleRate`, 'a positive number');
    }
    const list = byRole.get(role) ?? [];
    list.push({ id, role, url: `${root}${file}`, loop, frames, sampleRate });
    byRole.set(role, list);
  });
  return byRole;
}
