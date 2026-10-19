import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOV_RANGE } from '../engine/photo/PhotoMode';
import { FOCUS_DISTANCE_RANGE } from '../engine/photo/lens';
import {
  canSharePhoto,
  downloadPhoto,
  photoFile,
  photoFileName,
  sharePhoto,
  type DownloadHost,
} from './photoSave';
import { describeFocus, focusToSlider, FOV_DEGREES, sliderToFocus } from './photoSliders';

const blob = new Blob(['png'], { type: 'image/png' });

describe('photoFileName', () => {
  it('is a sortable local timestamp', () => {
    expect(photoFileName(new Date(2026, 0, 5, 3, 4, 9))).toBe('aquarium-2026-01-05-030409.png');
  });
});

describe('sharing', () => {
  const file = photoFile(blob, 'a.png');

  it('is offered only when the browser can share this file', () => {
    expect(canSharePhoto({}, file)).toBe(false);
    expect(canSharePhoto({ share: vi.fn() }, file)).toBe(false);
    expect(canSharePhoto({ share: vi.fn(), canShare: () => false }, file)).toBe(false);
    expect(canSharePhoto({ share: vi.fn(), canShare: () => true }, file)).toBe(true);
  });

  it('shares the file', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    await expect(sharePhoto({ share, canShare: () => true }, file)).resolves.toBe('shared');
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ files: [file] }));
  });

  it('treats a dismissed share sheet as a choice', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError'));
    await expect(sharePhoto({ share, canShare: () => true }, file)).resolves.toBe('cancelled');
  });

  it('explains a blocked share and a failed one, and keeps the cause', async () => {
    const blocked = new DOMException('no gesture', 'NotAllowedError');
    await expect(
      sharePhoto({ share: vi.fn().mockRejectedValue(blocked), canShare: () => true }, file),
    ).rejects.toThrow(/blocked/);
    await expect(
      sharePhoto({ share: vi.fn().mockRejectedValue(new Error('x')), canShare: () => true }, file),
    ).rejects.toMatchObject({ message: expect.stringContaining('failed') as string });
  });

  it('fails loudly when asked to share without support', async () => {
    await expect(sharePhoto({}, file)).rejects.toThrow(/cannot share/);
  });
});

describe('downloadPhoto', () => {
  afterEach(() => vi.useRealTimers());

  it('clicks a named link and frees the URL later', () => {
    vi.useFakeTimers();
    const anchor = { href: '', download: '', click: vi.fn() };
    const host: DownloadHost = {
      createObjectURL: () => 'blob:x',
      revokeObjectURL: vi.fn(),
      createAnchor: () => anchor,
    };
    downloadPhoto(host, blob, 'a.png');
    expect(anchor).toMatchObject({ href: 'blob:x', download: 'a.png' });
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(host.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(host.revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
});

describe('sliders', () => {
  it('maps focus both ways across the whole range', () => {
    expect(focusToSlider(FOCUS_DISTANCE_RANGE.min)).toBeCloseTo(0);
    expect(focusToSlider(FOCUS_DISTANCE_RANGE.max)).toBeCloseTo(1);
    for (const metres of [0.1, 0.45, 2, 15]) {
      expect(sliderToFocus(focusToSlider(metres))).toBeCloseTo(metres);
    }
  });

  it('clamps out-of-range input', () => {
    expect(sliderToFocus(-1)).toBeCloseTo(FOCUS_DISTANCE_RANGE.min);
    expect(sliderToFocus(2)).toBeCloseTo(FOCUS_DISTANCE_RANGE.max);
    expect(focusToSlider(0)).toBe(0);
  });

  it('says short distances in centimetres', () => {
    expect(describeFocus(0.45)).toBe('45 cm');
    expect(describeFocus(2.34)).toBe('2.3 m');
  });

  it('keeps the field-of-view range in step with the engine', () => {
    expect(FOV_DEGREES).toEqual(FOV_RANGE);
  });
});
