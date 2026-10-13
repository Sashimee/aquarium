import { describe, expect, it } from 'vitest';
import { isCompleteKtx2, ktx2MapRangeScale } from './textures.ts';

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

function ktx2(levels: { offset: number; length: number }[], fileBytes: number): Uint8Array {
  const bytes = new Uint8Array(fileBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(IDENTIFIER, 0);
  view.setUint32(40, levels.length, true);
  levels.forEach((level, i) => {
    view.setBigUint64(80 + i * 24, BigInt(level.offset), true);
    view.setBigUint64(88 + i * 24, BigInt(level.length), true);
  });
  return bytes;
}

describe('isCompleteKtx2', () => {
  it('accepts a file whose levels all lie inside it', () => {
    expect(isCompleteKtx2(ktx2([{ offset: 104, length: 96 }], 200))).toBe(true);
  });

  it('rejects a file cut off inside its last level', () => {
    const whole = ktx2([{ offset: 104, length: 96 }], 200);
    expect(isCompleteKtx2(whole.subarray(0, 150))).toBe(false);
  });

  it('rejects a file cut off inside the level index', () => {
    expect(
      isCompleteKtx2(
        ktx2(
          [
            { offset: 0, length: 0 },
            { offset: 0, length: 0 },
          ],
          200,
        ).subarray(0, 110),
      ),
    ).toBe(false);
  });

  it('rejects bytes without the KTX2 identifier and empty files', () => {
    const wrong = ktx2([{ offset: 104, length: 96 }], 200);
    wrong[1] = 0;
    expect(isCompleteKtx2(wrong)).toBe(false);
    expect(isCompleteKtx2(new Uint8Array(0))).toBe(false);
  });
});

function withKeyValues(entries: [string, number[]][]): Uint8Array {
  const parts: number[] = [];
  for (const [key, value] of entries) {
    const body = [...new TextEncoder().encode(key), 0, ...value];
    parts.push(body.length & 0xff, 0, 0, 0, ...body);
    while (parts.length % 4 !== 0) parts.push(0);
  }
  const bytes = new Uint8Array(120 + parts.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(56, 120, true);
  view.setUint32(60, parts.length, true);
  bytes.set(parts, 120);
  return bytes;
}

describe('ktx2MapRangeScale', () => {
  it('reads the scale of a KTXmapRange entry among others', () => {
    const range = new Uint8Array(8);
    new DataView(range.buffer).setFloat32(0, 1.125, true);
    const bytes = withKeyValues([
      ['KTXwriter', [65, 0]],
      ['KTXmapRange', [...range]],
    ]);
    expect(ktx2MapRangeScale(bytes)).toBe(1.125);
  });

  it('is 1 when the file has no KTXmapRange', () => {
    expect(ktx2MapRangeScale(withKeyValues([['KTXwriter', [65, 0]]]))).toBe(1);
  });
});
