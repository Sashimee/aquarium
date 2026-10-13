import { describe, expect, it } from 'vitest';
import { isCompleteKtx2 } from './textures.ts';

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
